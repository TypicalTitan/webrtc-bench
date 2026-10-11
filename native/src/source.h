// GPU video source: Media Foundation hardware decode -> D3D11 video processor scale/convert
// -> BGRA texture at the test resolution, plus the burned-in frame code.
#pragma once

#include "common.h"

#include <d3d11_1.h>
#include <dxgi1_2.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>

#include <condition_variable>
#include <deque>
#include <map>
#include <mutex>
#include <thread>

struct DecodedFrame {
    ComPtr<IMFSample> sample;      // keeps the decoder surface alive
    ComPtr<ID3D11Texture2D> texture;
    UINT subresource = 0;
    LONGLONG pts = 0;              // 100 ns units
};

/** Decodes a file on the GPU on a background thread, looping from `startSec`. */
class MfSource {
public:
    ~MfSource();
    bool open(ID3D11Device* device, const std::wstring& path, double startSec, std::string& err);
    void start();
    void stop();
    /** Blocks until a frame is available (or the reader failed). */
    bool pop(DecodedFrame& out, std::string& err);

    UINT width = 0;
    UINT height = 0;
    double fps = 0;
    LONGLONG segmentStart = 0;

private:
    bool readOne(DecodedFrame& out, std::string& err);
    void seekToStart();

    ComPtr<IMFDXGIDeviceManager> manager_;
    UINT token_ = 0;
    ComPtr<IMFSourceReader> reader_;
    std::thread thread_;
    std::mutex mu_;
    std::condition_variable cv_;
    std::deque<DecodedFrame> queue_;
    bool running_ = false;
    std::string error_;
};

/**
 * Live display capture (DXGI Desktop Duplication) for the mirroring mode. Frames are copied into
 * our own texture right away so the duplication frame can be released.
 */
class DisplaySource {
public:
    bool open(ID3D11Device* device, int outputIndex, std::string& err);
    /**
     * Grabs the newest desktop image if one was presented since the last call (waits up to
     * timeoutMs). Returns true with presentMs = QPC time the frame reached the screen.
     */
    bool acquire(UINT timeoutMs, double& presentMs, std::string& err);
    ID3D11Texture2D* texture() const { return copy_.Get(); }
    bool hasFrame() const { return hasFrame_; }

    UINT width = 0;
    UINT height = 0;
    std::string name;

private:
    bool duplicate(std::string& err);

    ComPtr<ID3D11Device> device_;
    ComPtr<ID3D11DeviceContext> ctx_;
    ComPtr<IDXGIOutput1> output_;
    ComPtr<IDXGIOutputDuplication> dup_;
    ComPtr<ID3D11Texture2D> copy_;
    bool hasFrame_ = false;
    double lostSinceMs_ = 0;
};

/** Prints the NVIDIA GPU's outputs as JSON lines (for --list-displays). */
void listDisplays(ID3D11Device* device);

/**
 * Scales/converts the source (NV12 decoder output or BGRA desktop) into the encoder input: NV12
 * (BT.709 limited range) or BGRA (full range), chosen by the target texture's format.
 */
class Scaler {
public:
    bool init(ID3D11Device* device, UINT inW, UINT inH, UINT outW, UINT outH, double fps, ID3D11Texture2D* target,
              bool rgbInput, std::string& err);
    bool blt(ID3D11Texture2D* input, UINT subresource, std::string& err);

private:
    ComPtr<ID3D11VideoDevice> vdev_;
    ComPtr<ID3D11VideoContext> vctx_;
    ComPtr<ID3D11VideoProcessorEnumerator> enum_;
    ComPtr<ID3D11VideoProcessor> vp_;
    ComPtr<ID3D11VideoProcessorOutputView> outView_;
    std::map<std::pair<ID3D11Texture2D*, UINT>, ComPtr<ID3D11VideoProcessorInputView>> inViews_;
};

/**
 * Burns the 16-bit frame code into the bottom-right corner (row A bits, row B inverted),
 * matching desktop/src/source.js and android LatencyProbe.kt. GPU-only (ClearView on the
 * encoder input), for NV12 (luma + neutral chroma planes) or BGRA targets.
 */
class FrameStamper {
public:
    bool init(ID3D11Device* device, ID3D11Texture2D* tex, std::string& err);
    void stamp(uint32_t frameNo);

private:
    ComPtr<ID3D11DeviceContext1> ctx_;
    ComPtr<ID3D11RenderTargetView> main_;    // luma plane (NV12) or the whole image (BGRA)
    ComPtr<ID3D11RenderTargetView> chroma_;  // NV12 only
    bool nv12_ = false;
    bool enabled_ = false;
    int x0_ = 0, y0_ = 0, bs_ = 0;
};
