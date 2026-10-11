#include "source.h"

#include <propvarutil.h>

#include <algorithm>
#include <cmath>
#include <vector>

MfSource::~MfSource() { stop(); }

bool MfSource::open(ID3D11Device* device, const std::wstring& path, double startSec, std::string& err) {
    HRESULT hr = MFCreateDXGIDeviceManager(&token_, &manager_);
    if (FAILED(hr)) return err = "MFCreateDXGIDeviceManager " + hrString(hr), false;
    manager_->ResetDevice(device, token_);

    ComPtr<IMFAttributes> attr;
    MFCreateAttributes(&attr, 4);
    attr->SetUnknown(MF_SOURCE_READER_D3D_MANAGER, manager_.Get());
    attr->SetUINT32(MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, TRUE);
    attr->SetUINT32(MF_SOURCE_READER_DISABLE_DXVA, FALSE);
    hr = MFCreateSourceReaderFromURL(path.c_str(), attr.Get(), &reader_);
    if (FAILED(hr)) return err = "cannot open video " + narrow(path) + " (" + hrString(hr) + ")", false;

    reader_->SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS, FALSE);
    reader_->SetStreamSelection(MF_SOURCE_READER_FIRST_VIDEO_STREAM, TRUE);
    ComPtr<IMFMediaType> type;
    MFCreateMediaType(&type);
    type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    type->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_NV12);
    hr = reader_->SetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM, nullptr, type.Get());
    if (FAILED(hr)) return err = "decoder cannot output NV12 (" + hrString(hr) + ")", false;

    ComPtr<IMFMediaType> cur;
    reader_->GetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM, &cur);
    MFGetAttributeSize(cur.Get(), MF_MT_FRAME_SIZE, &width, &height);
    UINT32 num = 0, den = 1;
    MFGetAttributeRatio(cur.Get(), MF_MT_FRAME_RATE, &num, &den);
    fps = den ? double(num) / den : 30.0;

    segmentStart = LONGLONG(startSec * 1e7);
    seekToStart();
    return true;
}

void MfSource::seekToStart() {
    PROPVARIANT var;
    InitPropVariantFromInt64(segmentStart, &var);
    reader_->SetCurrentPosition(GUID_NULL, var);
    PropVariantClear(&var);
}

bool MfSource::readOne(DecodedFrame& out, std::string& err) {
    for (int attempt = 0; attempt < 1000; attempt++) {
        DWORD flags = 0;
        LONGLONG ts = 0;
        ComPtr<IMFSample> sample;
        HRESULT hr = reader_->ReadSample(MF_SOURCE_READER_FIRST_VIDEO_STREAM, 0, nullptr, &flags, &ts, &sample);
        if (FAILED(hr)) return err = "ReadSample " + hrString(hr), false;
        if (flags & MF_SOURCE_READERF_ENDOFSTREAM) {
            seekToStart();  // loop the segment
            continue;
        }
        if (!sample) continue;
        ComPtr<IMFMediaBuffer> buf;
        sample->GetBufferByIndex(0, &buf);
        ComPtr<IMFDXGIBuffer> dxgi;
        if (FAILED(buf.As(&dxgi))) return err = "decoder did not return GPU frames (hardware decode unavailable)", false;
        out.sample = sample;
        dxgi->GetResource(IID_PPV_ARGS(&out.texture));
        dxgi->GetSubresourceIndex(&out.subresource);
        out.pts = ts;
        return true;
    }
    return err = "no frames from decoder", false;
}

void MfSource::start() {
    running_ = true;
    thread_ = std::thread([this] {
        while (true) {
            {
                std::unique_lock<std::mutex> lk(mu_);
                cv_.wait(lk, [this] { return !running_ || queue_.size() < 4; });
                if (!running_) return;
            }
            DecodedFrame f;
            std::string err;
            bool ok = readOne(f, err);
            std::lock_guard<std::mutex> lk(mu_);
            if (!ok) {
                error_ = err;
                running_ = false;
                cv_.notify_all();
                return;
            }
            queue_.push_back(std::move(f));
            cv_.notify_all();
        }
    });
}

void MfSource::stop() {
    {
        std::lock_guard<std::mutex> lk(mu_);
        running_ = false;
        cv_.notify_all();
    }
    if (thread_.joinable()) thread_.join();
    queue_.clear();
}

bool MfSource::pop(DecodedFrame& out, std::string& err) {
    std::unique_lock<std::mutex> lk(mu_);
    cv_.wait(lk, [this] { return !queue_.empty() || !running_; });
    if (queue_.empty()) return err = error_.empty() ? "source stopped" : error_, false;
    out = std::move(queue_.front());
    queue_.pop_front();
    cv_.notify_all();
    return true;
}

namespace {
/** Walks the outputs attached to the device's adapter. */
bool outputAt(ID3D11Device* device, int index, ComPtr<IDXGIOutput>& out) {
    ComPtr<IDXGIDevice> dxgi;
    ComPtr<IDXGIAdapter> adapter;
    if (FAILED(device->QueryInterface(IID_PPV_ARGS(&dxgi))) || FAILED(dxgi->GetAdapter(&adapter))) return false;
    return SUCCEEDED(adapter->EnumOutputs(UINT(index), &out));
}
}  // namespace

void listDisplays(ID3D11Device* device) {
    for (int i = 0;; i++) {
        ComPtr<IDXGIOutput> out;
        if (!outputAt(device, i, out)) break;
        DXGI_OUTPUT_DESC d;
        out->GetDesc(&d);
        const RECT& r = d.DesktopCoordinates;
        emit("{\"t\":\"display\",\"index\":%d,\"name\":\"%s\",\"x\":%ld,\"y\":%ld,\"width\":%ld,\"height\":%ld,\"attached\":%s}", i,
             jsonEscape(narrow(d.DeviceName)).c_str(), r.left, r.top, r.right - r.left, r.bottom - r.top,
             d.AttachedToDesktop ? "true" : "false");
    }
}

bool DisplaySource::open(ID3D11Device* device, int outputIndex, std::string& err) {
    device_ = device;
    device->GetImmediateContext(&ctx_);
    ComPtr<IDXGIOutput> out;
    if (!outputAt(device, outputIndex, out)) {
        return err = "display " + std::to_string(outputIndex) +
                     " is not connected to the NVIDIA GPU (on hybrid laptops, set the display to the discrete GPU / dGPU mode)",
               false;
    }
    if (FAILED(out.As(&output_))) return err = "IDXGIOutput1 unavailable", false;
    DXGI_OUTPUT_DESC d;
    output_->GetDesc(&d);
    width = UINT(d.DesktopCoordinates.right - d.DesktopCoordinates.left);
    height = UINT(d.DesktopCoordinates.bottom - d.DesktopCoordinates.top);
    name = narrow(d.DeviceName);
    D3D11_TEXTURE2D_DESC td = {};
    td.Width = width;
    td.Height = height;
    td.MipLevels = 1;
    td.ArraySize = 1;
    td.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    td.SampleDesc.Count = 1;
    td.Usage = D3D11_USAGE_DEFAULT;
    td.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
    if (FAILED(device->CreateTexture2D(&td, nullptr, &copy_))) return err = "cannot create capture texture", false;
    return duplicate(err);
}

bool DisplaySource::duplicate(std::string& err) {
    dup_.Reset();
    HRESULT hr = output_->DuplicateOutput(device_.Get(), &dup_);
    if (hr == DXGI_ERROR_UNSUPPORTED) return err = "Desktop Duplication unsupported on this display/GPU combination", false;
    if (FAILED(hr)) return err = "DuplicateOutput " + hrString(hr), false;
    return true;
}

bool DisplaySource::acquire(UINT timeoutMs, double& presentMs, std::string& err) {
    if (!dup_) {
        // Duplication is lost while a secure desktop (UAC, lock screen, Ctrl+Alt+Del) or a
        // display-mode change is up. Keep repeating the last image and retry; give up after 10 s.
        std::string why;
        if (!duplicate(why)) {
            if (lostSinceMs_ == 0) lostSinceMs_ = nowMs();
            if (nowMs() - lostSinceMs_ > 10000) err = "screen capture unavailable for 10 s: " + why;
            if (timeoutMs) Sleep(std::min<UINT>(timeoutMs, 50));
            return false;
        }
        lostSinceMs_ = 0;
    }
    DXGI_OUTDUPL_FRAME_INFO info = {};
    ComPtr<IDXGIResource> res;
    HRESULT hr = dup_->AcquireNextFrame(timeoutMs, &info, &res);
    if (hr == DXGI_ERROR_WAIT_TIMEOUT) return false;
    if (hr == DXGI_ERROR_ACCESS_LOST) {  // mode change, UAC prompt, full-screen switch...
        dup_.Reset();
        return false;
    }
    if (FAILED(hr)) {
        err = "AcquireNextFrame " + hrString(hr);
        return false;
    }
    bool fresh = false;
    if (info.LastPresentTime.QuadPart != 0) {  // 0 means only the mouse moved
        ComPtr<ID3D11Texture2D> tex;
        if (SUCCEEDED(res.As(&tex))) {
            ctx_->CopyResource(copy_.Get(), tex.Get());
            LARGE_INTEGER freq;
            QueryPerformanceFrequency(&freq);
            presentMs = double(info.LastPresentTime.QuadPart) * 1000.0 / double(freq.QuadPart);
            hasFrame_ = true;
            fresh = true;
        }
    }
    dup_->ReleaseFrame();
    return fresh;
}

bool Scaler::init(ID3D11Device* device, UINT inW, UINT inH, UINT outW, UINT outH, double fps, ID3D11Texture2D* target,
                  bool rgbInput, std::string& err) {
    if (FAILED(device->QueryInterface(IID_PPV_ARGS(&vdev_)))) return err = "no ID3D11VideoDevice", false;
    ComPtr<ID3D11DeviceContext> ctx;
    device->GetImmediateContext(&ctx);
    if (FAILED(ctx.As(&vctx_))) return err = "no ID3D11VideoContext", false;

    D3D11_VIDEO_PROCESSOR_CONTENT_DESC cd = {};
    cd.InputFrameFormat = D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE;
    cd.InputFrameRate = {UINT(std::lround(fps)), 1};
    cd.InputWidth = inW;
    cd.InputHeight = inH;
    cd.OutputFrameRate = {UINT(std::lround(fps)), 1};
    cd.OutputWidth = outW;
    cd.OutputHeight = outH;
    cd.Usage = D3D11_VIDEO_USAGE_PLAYBACK_NORMAL;
    HRESULT hr = vdev_->CreateVideoProcessorEnumerator(&cd, &enum_);
    if (FAILED(hr)) return err = "CreateVideoProcessorEnumerator " + hrString(hr), false;
    hr = vdev_->CreateVideoProcessor(enum_.Get(), 0, &vp_);
    if (FAILED(hr)) return err = "CreateVideoProcessor " + hrString(hr), false;

    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC ovd = {};
    ovd.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D;
    hr = vdev_->CreateVideoProcessorOutputView(target, enum_.Get(), &ovd, &outView_);
    if (FAILED(hr)) return err = "CreateVideoProcessorOutputView " + hrString(hr), false;

    // Decoder: BT.709 limited-range YCbCr in. Desktop: full-range RGB in. Out: BT.709 limited
    // YCbCr for an NV12 target (what the encoder signals in its VUI), full-range RGB for BGRA.
    D3D11_TEXTURE2D_DESC targetDesc;
    target->GetDesc(&targetDesc);
    const bool yuvOut = targetDesc.Format == DXGI_FORMAT_NV12;
    ComPtr<ID3D11VideoContext1> vctx1;
    if (SUCCEEDED(vctx_.As(&vctx1))) {
        vctx1->VideoProcessorSetStreamColorSpace1(
            vp_.Get(), 0, rgbInput ? DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709 : DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709);
        vctx1->VideoProcessorSetOutputColorSpace1(
            vp_.Get(), yuvOut ? DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709 : DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709);
    } else {
        D3D11_VIDEO_PROCESSOR_COLOR_SPACE in = {};
        in.YCbCr_Matrix = 1;
        in.Nominal_Range = rgbInput ? D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_0_255 : D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_16_235;
        vctx_->VideoProcessorSetStreamColorSpace(vp_.Get(), 0, &in);
        D3D11_VIDEO_PROCESSOR_COLOR_SPACE out = {};
        out.YCbCr_Matrix = 1;
        out.Nominal_Range = yuvOut ? D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_16_235 : D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_0_255;
        vctx_->VideoProcessorSetOutputColorSpace(vp_.Get(), &out);
    }
    vctx_->VideoProcessorSetStreamAutoProcessingMode(vp_.Get(), 0, FALSE);
    vctx_->VideoProcessorSetStreamFrameFormat(vp_.Get(), 0, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
    RECT src = {0, 0, LONG(inW), LONG(inH)};
    RECT dst = {0, 0, LONG(outW), LONG(outH)};
    vctx_->VideoProcessorSetStreamSourceRect(vp_.Get(), 0, TRUE, &src);
    vctx_->VideoProcessorSetStreamDestRect(vp_.Get(), 0, TRUE, &dst);
    vctx_->VideoProcessorSetOutputTargetRect(vp_.Get(), TRUE, &dst);
    return true;
}

bool Scaler::blt(ID3D11Texture2D* input, UINT subresource, std::string& err) {
    auto key = std::make_pair(input, subresource);
    auto it = inViews_.find(key);
    if (it == inViews_.end()) {
        D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC ivd = {};
        ivd.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;
        ivd.Texture2D.ArraySlice = subresource;
        ComPtr<ID3D11VideoProcessorInputView> view;
        HRESULT hr = vdev_->CreateVideoProcessorInputView(input, enum_.Get(), &ivd, &view);
        if (FAILED(hr)) return err = "CreateVideoProcessorInputView " + hrString(hr), false;
        it = inViews_.emplace(key, view).first;
    }
    D3D11_VIDEO_PROCESSOR_STREAM stream = {};
    stream.Enable = TRUE;
    stream.pInputSurface = it->second.Get();
    HRESULT hr = vctx_->VideoProcessorBlt(vp_.Get(), outView_.Get(), 0, 1, &stream);
    if (FAILED(hr)) return err = "VideoProcessorBlt " + hrString(hr), false;
    return true;
}

bool FrameStamper::init(ID3D11Device* device, ID3D11Texture2D* tex, std::string& err) {
    D3D11_TEXTURE2D_DESC d;
    tex->GetDesc(&d);
    const double s = d.Height / 1080.0;
    const int pad = int(std::lround(20 * s));
    bs_ = std::max(12, int(std::lround(16 * s)));
    x0_ = int(d.Width) - pad - 16 * bs_;
    y0_ = int(d.Height) - pad - 2 * bs_;
    enabled_ = x0_ >= 4 && y0_ >= 4;
    nv12_ = d.Format == DXGI_FORMAT_NV12;
    main_.Reset();
    chroma_.Reset();

    ComPtr<ID3D11DeviceContext> ctx;
    device->GetImmediateContext(&ctx);
    if (FAILED(ctx.As(&ctx_))) return err = "ID3D11DeviceContext1 unavailable", false;
    D3D11_RENDER_TARGET_VIEW_DESC rv = {};
    rv.ViewDimension = D3D11_RTV_DIMENSION_TEXTURE2D;
    // NV12 planes are addressed by view format: R8 = Y, R8G8 = interleaved CbCr (half size).
    rv.Format = nv12_ ? DXGI_FORMAT_R8_UNORM : d.Format;
    HRESULT hr = device->CreateRenderTargetView(tex, &rv, &main_);
    if (FAILED(hr)) return err = "frame-code view " + hrString(hr), false;
    if (nv12_) {
        rv.Format = DXGI_FORMAT_R8G8_UNORM;
        hr = device->CreateRenderTargetView(tex, &rv, &chroma_);
        if (FAILED(hr)) return err = "frame-code chroma view " + hrString(hr), false;
    }
    return true;
}

void FrameStamper::stamp(uint32_t frameNo) {
    if (!enabled_) return;
    const int bw = 16 * bs_ + 8, bh = 2 * bs_ + 8;
    const D3D11_RECT box = {x0_ - 4, y0_ - 4, x0_ - 4 + bw, y0_ - 4 + bh};
    D3D11_RECT white[16];
    const uint32_t code = frameNo & 0xFFFF;
    for (int i = 0; i < 16; i++) {
        const int row = ((code >> (15 - i)) & 1) ? 0 : 1;  // row A = bit, row B = inverted
        white[i] = {x0_ + i * bs_, y0_ + row * bs_, x0_ + (i + 1) * bs_, y0_ + (row + 1) * bs_};
    }
    // Limited-range luma for NV12 (16 / 235), full range for BGRA.
    const float black[4] = {nv12_ ? 16 / 255.f : 0.f, 0.f, 0.f, 1.f};
    const float bright[4] = {nv12_ ? 235 / 255.f : 1.f, nv12_ ? 0.f : 1.f, nv12_ ? 0.f : 1.f, 1.f};
    ctx_->ClearView(main_.Get(), black, &box, 1);
    ctx_->ClearView(main_.Get(), bright, white, 16);
    if (chroma_) {
        const float neutral[4] = {128 / 255.f, 128 / 255.f, 0.f, 0.f};
        const D3D11_RECT half = {box.left / 2, box.top / 2, (box.right + 1) / 2, (box.bottom + 1) / 2};
        ctx_->ClearView(chroma_.Get(), neutral, &half, 1);
    }
}
