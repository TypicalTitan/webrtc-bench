// wbsend: native NVENC sender for WebRTC Bench.
//
// Decodes a test clip on the GPU, scales it to the test resolution, stamps the frame code,
// encodes with NVENC (ultra-low-latency CBR, no B-frames) and sends each access unit as RTP over
// UDP the moment it is encoded. Every frame carries an SEI with its capture time converted to
// the TV's clock, so the TV can compute capture -> decoded latency itself.
//
// The desktop app drives it: arguments in, JSON lines out on stdout, "stop"/"idr" on stdin.

#include "common.h"
#include "nvenc.h"
#include "rtp.h"
#include "source.h"

#include <dxgi1_2.h>
#include <timeapi.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdarg>
#include <iostream>
#include <limits>
#include <map>
#include <mutex>

namespace {
std::mutex g_outMu;
std::atomic<bool> g_running{true};

std::map<std::string, std::string> parseArgs(int argc, wchar_t** argv) {
    std::map<std::string, std::string> a;
    for (int i = 1; i < argc; i++) {
        std::string s = narrow(argv[i]);
        if (s.rfind("--", 0) != 0) continue;
        auto eq = s.find('=');
        if (eq == std::string::npos) a[s.substr(2)] = "1";
        else a[s.substr(2, eq - 2)] = s.substr(eq + 1);
    }
    return a;
}

int argInt(const std::map<std::string, std::string>& a, const char* k, int def) {
    auto it = a.find(k);
    return it == a.end() ? def : std::stoi(it->second);
}
double argDouble(const std::map<std::string, std::string>& a, const char* k, double def) {
    auto it = a.find(k);
    return it == a.end() ? def : std::stod(it->second);
}
std::string argStr(const std::map<std::string, std::string>& a, const char* k, const std::string& def) {
    auto it = a.find(k);
    return it == a.end() ? def : it->second;
}

int fail(const std::string& msg) {
    emit("{\"t\":\"error\",\"message\":\"%s\"}", jsonEscape(msg).c_str());
    return 1;
}

/** User-data-unregistered SEI: 16-byte UUID, frame number, capture time on the TV clock and ours. */
std::vector<uint8_t> makeSei(uint32_t frameNo, double captureTvMs, double captureLocalMs) {
    static const char kUuid[17] = "WebRTCBenchSEI01";
    std::vector<uint8_t> s(16 + 4 + 8 + 8);
    memcpy(s.data(), kUuid, 16);
    s[16] = uint8_t(frameNo >> 24);
    s[17] = uint8_t(frameNo >> 16);
    s[18] = uint8_t(frameNo >> 8);
    s[19] = uint8_t(frameNo);
    auto putF64 = [&](size_t at, double d) {
        uint64_t v;
        memcpy(&v, &d, 8);
        for (int i = 0; i < 8; i++) s[at + size_t(i)] = uint8_t(v >> (56 - 8 * i));
    };
    putF64(20, captureTvMs);
    putF64(28, captureLocalMs);
    return s;
}

/**
 * Inserts a user-data-unregistered SEI NAL carrying `payload` before the first picture NAL of an
 * Annex-B access unit (pre-encoded streaming: the capture time is only known when sending).
 */
std::vector<uint8_t> withSeiNal(const std::vector<uint8_t>& au, const std::vector<uint8_t>& payload, Codec codec) {
    const bool hevc = codec == Codec::HEVC;
    std::vector<uint8_t> raw = hevc ? std::vector<uint8_t>{39 << 1, 1} : std::vector<uint8_t>{6};
    const size_t headerLen = raw.size();
    raw.push_back(5);
    raw.push_back(uint8_t(payload.size()));
    raw.insert(raw.end(), payload.begin(), payload.end());
    raw.push_back(0x80);
    std::vector<uint8_t> nal = {0, 0, 0, 1};
    int zeros = 0;
    for (size_t i = 0; i < raw.size(); i++) {
        if (i >= headerLen && zeros >= 2 && raw[i] <= 3) {
            nal.push_back(3);  // emulation prevention
            zeros = 0;
        }
        nal.push_back(raw[i]);
        zeros = raw[i] == 0 ? zeros + 1 : 0;
    }
    size_t at = 0;
    for (size_t i = 0; i + 4 < au.size(); i++) {
        if (au[i] != 0 || au[i + 1] != 0 || au[i + 2] != 1) continue;
        const int type = hevc ? (au[i + 3] >> 1) & 0x3f : au[i + 3] & 0x1f;
        if (hevc ? type <= 31 : (type >= 1 && type <= 5)) {
            at = (i > 0 && au[i - 1] == 0) ? i - 1 : i;
            break;
        }
    }
    std::vector<uint8_t> out;
    out.reserve(au.size() + nal.size());
    out.insert(out.end(), au.begin(), au.begin() + ptrdiff_t(at));
    out.insert(out.end(), nal.begin(), nal.end());
    out.insert(out.end(), au.begin() + ptrdiff_t(at), au.end());
    return out;
}

bool createDevice(ComPtr<ID3D11Device>& dev, ComPtr<ID3D11DeviceContext>& ctx, std::string& adapterName, std::string& err) {
    ComPtr<IDXGIFactory1> factory;
    if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) return err = "CreateDXGIFactory1 failed", false;
    ComPtr<IDXGIAdapter1> adapter;
    for (UINT i = 0;; i++) {
        ComPtr<IDXGIAdapter1> a;
        if (factory->EnumAdapters1(i, &a) == DXGI_ERROR_NOT_FOUND) break;
        DXGI_ADAPTER_DESC1 d;
        a->GetDesc1(&d);
        if (d.VendorId == 0x10DE) {  // NVIDIA
            adapter = a;
            adapterName = narrow(d.Description);
            break;
        }
    }
    if (!adapter) return err = "no NVIDIA GPU found", false;
    const D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0};
    HRESULT hr = D3D11CreateDevice(adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
                                   D3D11_CREATE_DEVICE_VIDEO_SUPPORT | D3D11_CREATE_DEVICE_BGRA_SUPPORT, levels, 2,
                                   D3D11_SDK_VERSION, &dev, nullptr, &ctx);
    if (FAILED(hr)) return err = "D3D11CreateDevice " + hrString(hr), false;
    ComPtr<ID3D10Multithread> mt;
    if (SUCCEEDED(dev.As(&mt))) mt->SetMultithreadProtected(TRUE);  // shared with the MF decoder thread
    return true;
}
}  // namespace

void emit(const char* fmt, ...) {
    std::lock_guard<std::mutex> lk(g_outMu);
    va_list ap;
    va_start(ap, fmt);
    vfprintf(stdout, fmt, ap);
    va_end(ap);
    fputc('\n', stdout);
    fflush(stdout);
}

int wmain(int argc, wchar_t** argv) {
    const auto args = parseArgs(argc, argv);
    const std::string tv = argStr(args, "tv", "");
    const std::wstring file = widen(argStr(args, "file", ""));
    const bool displayMode = argStr(args, "source", "file") == "display";
    if (args.count("list-displays")) {
        CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        std::string err, adapterName;
        ComPtr<ID3D11Device> dev;
        ComPtr<ID3D11DeviceContext> ctx;
        if (!createDevice(dev, ctx, adapterName, err)) return fail(err);
        listDisplays(dev.Get());
        return 0;
    }
    // --sink=tcp:<port>: hand encoded frames to the desktop app (127.0.0.1) instead of sending RTP
    // to the TV; the app sends them over WebRTC (cloud-gaming profile with the NVENC sender).
    const std::string sinkArg = argStr(args, "sink", "");
    const int sinkPort = sinkArg.rfind("tcp:", 0) == 0 ? std::stoi(sinkArg.substr(4)) : 0;
    if ((tv.empty() && !sinkPort) || (file.empty() && !displayMode)) {
        return fail("usage: wbsend (--tv=<ip> | --sink=tcp:<port>) (--file=<video> | --source=display [--display=0]) [--port=47812 --codec=h264|hevc --width --height --fps --kbps --start --duration --preset=1..7 --profile --input=nv12|bgra --split=auto|disable|2|3|4 --mtu]");
    }

    EncoderSettings es;
    const std::string codecArg = argStr(args, "codec", "h264");
    es.codec = (codecArg == "hevc" || codecArg == "h265") ? Codec::HEVC : Codec::H264;
    es.width = argInt(args, "width", 1920);
    es.height = argInt(args, "height", 1080);
    es.fps = argInt(args, "fps", 60);
    es.kbps = argInt(args, "kbps", 12000);
    es.preset = argInt(args, "preset", 1);
    es.h264Profile = argStr(args, "profile", "high");
    es.nv12 = argStr(args, "input", "nv12") != "bgra";
    // HEVC split-frame encoding: three strips on separate NVENC engines measured fastest from
    // 1080p up (RTX 50: 4K 6.1 -> 2.4 ms, 1080p 1.3 -> 0.8 ms); below that the driver's choice.
    const std::string split = argStr(args, "split", "best");
    es.splitMode = split == "best"      ? (es.height >= 1080 ? NV_ENC_SPLIT_THREE_FORCED_MODE : -1)
                   : split == "auto"    ? -1
                   : split == "disable" ? NV_ENC_SPLIT_DISABLE_MODE
                   : split == "forced"  ? NV_ENC_SPLIT_AUTO_FORCED_MODE
                                        : std::stoi(split);
    const int port = argInt(args, "port", 47812);
    const double startSec = argDouble(args, "start", 0);
    const double durationSec = argDouble(args, "duration", 0);

    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    MFStartup(MF_VERSION);
    timeBeginPeriod(1);
    SetPriorityClass(GetCurrentProcess(), HIGH_PRIORITY_CLASS);

    std::string err, adapterName;
    ComPtr<ID3D11Device> dev;
    ComPtr<ID3D11DeviceContext> ctx;
    if (!createDevice(dev, ctx, adapterName, err)) return fail(err);

    MfSource source;
    DisplaySource display;
    UINT srcW = 0, srcH = 0;
    double srcFps = es.fps;
    std::string srcName;
    if (displayMode) {
        if (!display.open(dev.Get(), argInt(args, "display", 0), err)) return fail(err);
        srcW = display.width;
        srcH = display.height;
        srcName = display.name;
    } else {
        if (!source.open(dev.Get(), file, startSec, err)) return fail(err);
        srcW = source.width;
        srcH = source.height;
        srcFps = source.fps;
    }

    // Encoder input. NV12 straight from the video processor saves NVENC an RGB->YUV pass; BGRA
    // is the fallback for GPUs/drivers without NV12 render targets.
    D3D11_TEXTURE2D_DESC td = {};
    td.Width = UINT(es.width);
    td.Height = UINT(es.height);
    td.MipLevels = 1;
    td.ArraySize = 1;
    td.Format = es.nv12 ? DXGI_FORMAT_NV12 : DXGI_FORMAT_B8G8R8A8_UNORM;
    td.SampleDesc.Count = 1;
    td.Usage = D3D11_USAGE_DEFAULT;
    td.BindFlags = D3D11_BIND_RENDER_TARGET;
    ComPtr<ID3D11Texture2D> frameTex;
    Scaler scaler;
    FrameStamper stamper;
    auto prepareInput = [&](std::string& why) {
        frameTex.Reset();
        td.Format = es.nv12 ? DXGI_FORMAT_NV12 : DXGI_FORMAT_B8G8R8A8_UNORM;
        HRESULT hr = dev->CreateTexture2D(&td, nullptr, &frameTex);
        if (FAILED(hr)) return why = "cannot create encoder input texture " + hrString(hr), false;
        return scaler.init(dev.Get(), srcW, srcH, td.Width, td.Height, srcFps, frameTex.Get(), displayMode, why) &&
               stamper.init(dev.Get(), frameTex.Get(), why);
    };
    if (!prepareInput(err)) {
        if (!es.nv12) return fail(err);
        es.nv12 = false;  // retry with BGRA
        err.clear();
        if (!prepareInput(err)) return fail(err);
    }
    ComPtr<ID3D11Query> gpuDone;
    D3D11_QUERY_DESC qd = {D3D11_QUERY_EVENT, 0};
    if (FAILED(dev->CreateQuery(&qd, &gpuDone))) return fail("cannot create GPU event query");

    Nvenc enc;
    if (!enc.open(dev.Get(), es, err)) return fail(err);
    if (!enc.registerInput(frameTex.Get(), err)) return fail(err);

    RtpSender rtp;
    FrameSink sink;
    rtp.mtu = argInt(args, "mtu", 1200);
    double offsetMs = 0, syncRttMs = 0;
    if (sinkPort) {
        if (!sink.open(sinkPort, err)) return fail(err);
    } else {
        if (!rtp.open(tv, port, err)) return fail(err);
        // --nosync: test the pipeline without a receiver (latency timestamps are then meaningless).
        if (!args.count("nosync") && !rtp.clockSync(20, offsetMs, syncRttMs, err)) return fail(err);
    }

    if (!displayMode) source.start();
    const double srcStep = srcFps / es.fps;  // source frames consumed per output frame (file mode)
    double srcAcc = 0.0;
    DecodedFrame current;
    /** Next source picture into the encoder input texture (file mode). */
    auto nextFilePicture = [&](std::string& why) {
        // Advance the source by srcStep frames per output frame: 60->60 takes one, 60->30 takes
        // two (keeping the second), 59.94->60 occasionally repeats a frame.
        if (!current.texture) {
            if (!source.pop(current, why)) return false;
        } else {
            srcAcc += srcStep;
            while (srcAcc >= 1.0) {
                if (!source.pop(current, why)) return false;
                srcAcc -= 1.0;
            }
        }
        return scaler.blt(current.texture.Get(), current.subresource, why);
    };
    auto waitGpu = [&] {
        ctx->End(gpuDone.Get());
        ctx->Flush();
        while (ctx->GetData(gpuDone.Get(), nullptr, 0, 0) == S_FALSE) YieldProcessor();
    };

    // --preencoded[=seconds]: encode the clip segment first (default 10 s, keyframe every --gop
    // frames, default 2 s), then stream the stored frames, each timestamped when it is sent.
    // Latency then covers transfer, receive and decode (and display) only, no capture or encode.
    struct StoredAu {
        std::vector<uint8_t> data;
        bool key;
    };
    std::vector<StoredAu> stored;
    const bool preencoded = args.count("preencoded") > 0;
    if (preencoded) {
        if (displayMode) return fail("--preencoded needs a video file, not the display");
        const double secs = argDouble(args, "preencoded", 1) > 1 ? argDouble(args, "preencoded", 10) : 10.0;
        const int count = int(std::min(secs, 30.0) * es.fps);
        const int gop = std::max(1, argInt(args, "gop", es.fps * 2));
        std::vector<uint8_t> out;
        for (int i = 0; i < count && g_running; i++) {
            if (!nextFilePicture(err)) return fail(err);
            stamper.stamp(uint32_t(i));
            waitGpu();
            bool key = false;
            if (!enc.encode(uint64_t(i), i % gop == 0, {}, out, key, err)) return fail(err);
            stored.push_back({out, key});
        }
    }
    const std::string encoderDesc = enc.description() + (preencoded ? " (pre-encoded)" : "");
    emit("{\"t\":\"ready\",\"encoder\":\"%s\",\"adapter\":\"%s\",\"width\":%d,\"height\":%d,\"fps\":%d,\"kbps\":%d,"
         "\"source\":\"%s\",\"srcName\":\"%s\",\"srcWidth\":%u,\"srcHeight\":%u,\"srcFps\":%.3f,\"offsetMs\":%.3f,\"syncRttMs\":%.3f,\"qpcMs\":%.3f,\"preencoded\":%s}",
         jsonEscape(encoderDesc).c_str(), jsonEscape(adapterName).c_str(), es.width, es.height, es.fps, es.kbps,
         displayMode ? "display" : "file", jsonEscape(srcName).c_str(), srcW, srcH, srcFps, offsetMs, syncRttMs, nowMs(),
         preencoded ? "true" : "false");

    // Control from the desktop app: "stop", "idr", "shift <ms>" (frame-clock phase, from the TV's
    // vsync pacer when the frames go over WebRTC). End-of-input is not a stop request (stdin may
    // simply be absent); the app always passes --duration as a safety net.
    std::thread stdinThread([&rtp] {
        std::string line;
        while (std::getline(std::cin, line)) {
            if (line.rfind("stop", 0) == 0) {
                g_running = false;
                return;
            }
            if (line.rfind("idr", 0) == 0) rtp.keyframeWanted = true;
            if (line.rfind("shift ", 0) == 0) {
                const double ms = std::atof(line.c_str() + 6);
                double cur = rtp.phaseShiftMs.load();
                while (!rtp.phaseShiftMs.compare_exchange_weak(cur, cur + ms)) {
                }
            }
        }
    });
    stdinThread.detach();

    HANDLE timer = CreateWaitableTimerExW(nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS);
    const double interval = 1000.0 / es.fps;
    const double t0 = nowMs();
    double next = t0;
    std::vector<uint8_t> au;
    size_t storedPos = 0;

    // Per-second statistics.
    double statStart = t0, encSum = 0, sendSum = 0, prepSum = 0, maxFrameKB = 0, statShift = 0;
    int statFrames = 0, statKeyframes = 0, late = 0, statFresh = 0, statCapDelayN = 0;
    double statCapDelaySum = 0;
    uint64_t statBytes0 = 0;

    for (uint64_t n = 0; g_running; n++) {
        if (durationSec > 0 && nowMs() - t0 > durationSec * 1000) break;
        // The TV's vsync pacer moves our frame clock so frames finish decoding just before its
        // compositor picks them up (see NativeReceiver.Pacer).
        const double shift = rtp.phaseShiftMs.exchange(0.0);
        if (shift != 0.0) {
            const double s = std::clamp(shift, -interval, interval);
            next += s;
            statShift += s;
        }
        const double wait = next - nowMs();
        if (wait > 1.5) {
            LARGE_INTEGER due;
            due.QuadPart = -LONGLONG((wait - 1.0) * 10000.0);
            SetWaitableTimer(timer, &due, 0, nullptr, nullptr, FALSE);
            WaitForSingleObject(timer, INFINITE);
        }
        while (nowMs() < next) YieldProcessor();

        // Capture time for latency: when the frame reached the screen (display mode) or when we
        // start preparing it (file mode, so scaling counts). NaN = repeated content, excluded.
        const double frameStart = nowMs();
        double contentMs = std::numeric_limits<double>::quiet_NaN();
        if (preencoded) {
            // A keyframe request jumps to the next stored keyframe.
            if (rtp.keyframeWanted.exchange(false)) {
                while (!stored[storedPos % stored.size()].key) storedPos++;
            }
            const StoredAu& s = stored[storedPos++ % stored.size()];
            contentMs = frameStart;  // "captured" = sent
            au = sinkPort ? s.data : withSeiNal(s.data, makeSei(uint32_t(n), contentMs + offsetMs, contentMs), es.codec);
            if (sinkPort) {
                if (!sink.send(au, uint32_t(n), s.key, contentMs)) return fail("the desktop app closed the frame connection");
            } else {
                rtp.sendAccessUnit(au, es.codec, uint32_t(frameStart * 90.0));
            }
            const double sentAt = nowMs();
            statFrames++;
            statFresh++;
            sendSum += sentAt - frameStart;
            if (s.key) statKeyframes++;
            maxFrameKB = std::max(maxFrameKB, au.size() / 1024.0);
        } else {
        if (displayMode) {
            // Newest desktop image; on the first frame wait for one. A static screen repeats the
            // previous image (only the frame code changes).
            double presentMs = 0;
            const bool fresh = display.acquire(display.hasFrame() ? 0 : 500, presentMs, err);
            if (!err.empty()) return fail(err);
            if (!display.hasFrame()) continue;
            if (fresh) {
                if (!scaler.blt(display.texture(), 0, err)) return fail(err);
                contentMs = presentMs;
                statFresh++;
            }
        } else {
            if (!nextFilePicture(err)) return fail(err);
            statFresh++;
        }
        stamper.stamp(uint32_t(n));
        // Wait for the scale/convert/stamp GPU work so encode time below is NVENC alone.
        waitGpu();

        const double prepared = nowMs();
        if (!displayMode) contentMs = frameStart;
        else if (!std::isnan(contentMs)) {
            statCapDelaySum += prepared - contentMs;  // screen present -> ready for NVENC
            statCapDelayN++;
        }
        const bool forceIdr = n == 0 || rtp.keyframeWanted.exchange(false);
        bool keyframe = false;
        // Over WebRTC the app adds the timing SEI itself (it owns the TV clock offset).
        const std::vector<uint8_t> sei = sinkPort ? std::vector<uint8_t>() : makeSei(uint32_t(n), contentMs + offsetMs, contentMs);
        if (!enc.encode(n, forceIdr, sei, au, keyframe, err)) return fail(err);
        const double encoded = nowMs();
        if (sinkPort) {
            if (!sink.send(au, uint32_t(n), keyframe, contentMs)) return fail("the desktop app closed the frame connection");
        } else {
            rtp.sendAccessUnit(au, es.codec, uint32_t(frameStart * 90.0));
        }
        const double sent = nowMs();

        statFrames++;
        prepSum += prepared - frameStart;
        encSum += encoded - prepared;
        sendSum += sent - encoded;
        if (keyframe) statKeyframes++;
        maxFrameKB = std::max(maxFrameKB, au.size() / 1024.0);
        }

        next += interval;
        if (nowMs() - next > 4 * interval) {  // fell far behind: resynchronize instead of bursting
            next = nowMs() + interval;
            late++;
        }

        const double now = nowMs();
        if (now - statStart >= 1000.0) {
            const double dt = (now - statStart) / 1000.0;
            char capDelay[32] = "null";
            if (statCapDelayN) snprintf(capDelay, sizeof capDelay, "%.3f", statCapDelaySum / statCapDelayN);
            emit("{\"t\":\"stats\",\"ts\":%.1f,\"frames\":%d,\"fps\":%.2f,\"contentFps\":%.2f,\"kbps\":%.1f,\"prepMs\":%.3f,\"encodeMs\":%.3f,\"sendMs\":%.3f,"
                 "\"captureDelayMs\":%s,\"maxFrameKB\":%.1f,\"keyframes\":%d,\"keyframeRequests\":%d,\"packets\":%llu,\"late\":%d,\"phaseShiftMs\":%.3f}",
                 now, statFrames, statFrames / dt, statFresh / dt, (rtp.bytesSent - statBytes0) * 8.0 / dt / 1000.0,
                 prepSum / statFrames, encSum / statFrames, sendSum / statFrames, capDelay, maxFrameKB, statKeyframes,
                 rtp.keyframeRequests.load(), static_cast<unsigned long long>(rtp.packetsSent), late, statShift);
            statStart = now;
            statFrames = 0;
            statFresh = 0;
            statCapDelaySum = 0;
            statCapDelayN = 0;
            statKeyframes = 0;
            encSum = sendSum = prepSum = maxFrameKB = statShift = 0;
            statBytes0 = rtp.bytesSent;
        }
    }

    source.stop();
    CloseHandle(timer);
    emit("{\"t\":\"done\"}");
    timeEndPeriod(1);
    MFShutdown();
    return 0;
}
