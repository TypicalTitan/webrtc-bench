// Thin NVENC (Video Codec SDK API) wrapper: D3D11 NV12 (or BGRA) texture in, Annex-B bitstream out.
#pragma once

#include "common.h"

#include <d3d11.h>
#include "nvEncodeAPI.h"

#include <vector>

struct EncoderSettings {
    Codec codec = Codec::H264;
    int width = 1920;
    int height = 1080;
    int fps = 60;
    int kbps = 12000;
    int preset = 1;               // P1..P7 (lower = faster)
    std::string h264Profile = "high"; // baseline | main | high
    bool nv12 = true;             // NV12 input (BT.709 limited range); false = BGRA, converted by NVENC
    int splitMode = -1;           // HEVC split-frame encoding (NV_ENC_SPLIT_*); -1 = driver default
};

class Nvenc {
public:
    ~Nvenc();
    bool open(ID3D11Device* device, const EncoderSettings& s, std::string& err);
    bool registerInput(ID3D11Texture2D* tex, std::string& err);
    /** Encodes the registered texture. `sei` is inserted as a user-data-unregistered SEI. */
    bool encode(uint64_t frameNo, bool forceIdr, const std::vector<uint8_t>& sei,
                std::vector<uint8_t>& out, bool& isKeyframe, std::string& err);
    std::string description() const { return desc_; }

private:
    std::string status(NVENCSTATUS st) const;

    HMODULE lib_ = nullptr;
    NV_ENCODE_API_FUNCTION_LIST fn_ = {};
    void* enc_ = nullptr;
    NV_ENC_OUTPUT_PTR bitstream_ = nullptr;
    NV_ENC_REGISTERED_PTR registered_ = nullptr;
    EncoderSettings s_;
    std::string desc_;
};
