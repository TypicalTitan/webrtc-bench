#include "nvenc.h"

#include <cstring>

namespace {
typedef NVENCSTATUS(NVENCAPI* PfnCreateInstance)(NV_ENCODE_API_FUNCTION_LIST*);
typedef NVENCSTATUS(NVENCAPI* PfnGetMaxVersion)(uint32_t*);

const GUID& presetGuid(int p) {
    switch (p) {
        case 1: return NV_ENC_PRESET_P1_GUID;
        case 2: return NV_ENC_PRESET_P2_GUID;
        case 4: return NV_ENC_PRESET_P4_GUID;
        case 5: return NV_ENC_PRESET_P5_GUID;
        case 6: return NV_ENC_PRESET_P6_GUID;
        case 7: return NV_ENC_PRESET_P7_GUID;
        case 3: return NV_ENC_PRESET_P3_GUID;
        default: return NV_ENC_PRESET_P1_GUID;
    }
}

/** NV12 input is BT.709 limited range (what the video processor writes); say so in the VUI. */
template <typename Vui>
void setVui709(Vui& v) {
    v.videoSignalTypePresentFlag = 1;
    v.videoFormat = NV_ENC_VUI_VIDEO_FORMAT_UNSPECIFIED;
    v.videoFullRangeFlag = 0;
    v.colourDescriptionPresentFlag = 1;
    v.colourPrimaries = NV_ENC_VUI_COLOR_PRIMARIES_BT709;
    v.transferCharacteristics = NV_ENC_VUI_TRANSFER_CHARACTERISTIC_BT709;
    v.colourMatrix = NV_ENC_VUI_MATRIX_COEFFS_BT709;
}
}  // namespace

Nvenc::~Nvenc() {
    if (enc_) {
        if (registered_) fn_.nvEncUnregisterResource(enc_, registered_);
        if (bitstream_) fn_.nvEncDestroyBitstreamBuffer(enc_, bitstream_);
        fn_.nvEncDestroyEncoder(enc_);
    }
    if (lib_) FreeLibrary(lib_);
}

std::string Nvenc::status(NVENCSTATUS st) const {
    std::string msg = "NVENC status " + std::to_string(int(st));
    if (enc_ && fn_.nvEncGetLastErrorString) {
        const char* s = fn_.nvEncGetLastErrorString(enc_);
        if (s && *s) msg += std::string(": ") + s;
    }
    return msg;
}

bool Nvenc::open(ID3D11Device* device, const EncoderSettings& s, std::string& err) {
    s_ = s;
    lib_ = LoadLibraryW(L"nvEncodeAPI64.dll");
    if (!lib_) return err = "nvEncodeAPI64.dll not found (NVIDIA driver with NVENC required)", false;
    auto getMax = reinterpret_cast<PfnGetMaxVersion>(GetProcAddress(lib_, "NvEncodeAPIGetMaxSupportedVersion"));
    auto create = reinterpret_cast<PfnCreateInstance>(GetProcAddress(lib_, "NvEncodeAPICreateInstance"));
    if (!getMax || !create) return err = "NVENC entry points missing", false;
    uint32_t maxVer = 0;
    getMax(&maxVer);
    const uint32_t needVer = (NVENCAPI_MAJOR_VERSION << 4) | NVENCAPI_MINOR_VERSION;
    if (needVer > maxVer) {
        return err = "driver supports NVENC API " + std::to_string(maxVer >> 4) + "." + std::to_string(maxVer & 15) +
                     ", need " + std::to_string(NVENCAPI_MAJOR_VERSION) + "." + std::to_string(NVENCAPI_MINOR_VERSION),
               false;
    }
    fn_.version = NV_ENCODE_API_FUNCTION_LIST_VER;
    NVENCSTATUS st = create(&fn_);
    if (st != NV_ENC_SUCCESS) return err = status(st), false;

    NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS op = {};
    op.version = NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER;
    op.deviceType = NV_ENC_DEVICE_TYPE_DIRECTX;
    op.device = device;
    op.apiVersion = NVENCAPI_VERSION;
    st = fn_.nvEncOpenEncodeSessionEx(&op, &enc_);
    if (st != NV_ENC_SUCCESS) return err = "open session: " + status(st), false;

    const GUID codecGuid = s.codec == Codec::H264 ? NV_ENC_CODEC_H264_GUID : NV_ENC_CODEC_HEVC_GUID;
    const GUID& preset = presetGuid(s.preset);
    NV_ENC_PRESET_CONFIG pc = {};
    pc.version = NV_ENC_PRESET_CONFIG_VER;
    pc.presetCfg.version = NV_ENC_CONFIG_VER;
    st = fn_.nvEncGetEncodePresetConfigEx(enc_, codecGuid, preset, NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY, &pc);
    if (st != NV_ENC_SUCCESS) return err = "preset config: " + status(st), false;

    NV_ENC_CONFIG cfg = pc.presetCfg;
    cfg.version = NV_ENC_CONFIG_VER;
    // Streaming settings: P-frames only, no automatic keyframes (the receiver asks for one
    // after loss), constant bitrate with a one-frame VBV so no frame waits in a buffer.
    cfg.gopLength = NVENC_INFINITE_GOPLENGTH;
    cfg.frameIntervalP = 1;
    const uint32_t bps = uint32_t(s.kbps) * 1000u;
    cfg.rcParams.rateControlMode = NV_ENC_PARAMS_RC_CBR;
    cfg.rcParams.averageBitRate = bps;
    cfg.rcParams.maxBitRate = bps;
    cfg.rcParams.vbvBufferSize = bps / uint32_t(s.fps);
    cfg.rcParams.vbvInitialDelay = cfg.rcParams.vbvBufferSize;
    cfg.rcParams.zeroReorderDelay = 1;
    if (s.codec == Codec::H264) {
        cfg.profileGUID = s.h264Profile == "baseline" ? NV_ENC_H264_PROFILE_BASELINE_GUID
                          : s.h264Profile == "main"   ? NV_ENC_H264_PROFILE_MAIN_GUID
                                                      : NV_ENC_H264_PROFILE_HIGH_GUID;
        auto& h = cfg.encodeCodecConfig.h264Config;
        h.idrPeriod = NVENC_INFINITE_GOPLENGTH;
        h.repeatSPSPPS = 1;
        h.chromaFormatIDC = 1;
        if (s.nv12) setVui709(h.h264VUIParameters);
    } else {
        cfg.profileGUID = NV_ENC_HEVC_PROFILE_MAIN_GUID;
        auto& h = cfg.encodeCodecConfig.hevcConfig;
        h.idrPeriod = NVENC_INFINITE_GOPLENGTH;
        h.repeatSPSPPS = 1;
        h.chromaFormatIDC = 1;
        if (s.nv12) setVui709(h.hevcVUIParameters);
    }

    NV_ENC_INITIALIZE_PARAMS ip = {};
    ip.version = NV_ENC_INITIALIZE_PARAMS_VER;
    ip.encodeGUID = codecGuid;
    ip.presetGUID = preset;
    ip.tuningInfo = NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY;
    ip.encodeWidth = uint32_t(s.width);
    ip.encodeHeight = uint32_t(s.height);
    ip.darWidth = uint32_t(s.width);
    ip.darHeight = uint32_t(s.height);
    ip.maxEncodeWidth = uint32_t(s.width);
    ip.maxEncodeHeight = uint32_t(s.height);
    ip.frameRateNum = uint32_t(s.fps);
    ip.frameRateDen = 1;
    ip.enablePTD = 1;
    // Split-frame encoding spreads one HEVC frame over several NVENC engines (H.264 can't).
    if (s.codec == Codec::HEVC && s.splitMode >= 0) ip.splitEncodeMode = uint32_t(s.splitMode);
    ip.encodeConfig = &cfg;
    st = fn_.nvEncInitializeEncoder(enc_, &ip);
    if (st != NV_ENC_SUCCESS) return err = "initialize encoder: " + status(st), false;

    NV_ENC_CREATE_BITSTREAM_BUFFER bb = {};
    bb.version = NV_ENC_CREATE_BITSTREAM_BUFFER_VER;
    st = fn_.nvEncCreateBitstreamBuffer(enc_, &bb);
    if (st != NV_ENC_SUCCESS) return err = "bitstream buffer: " + status(st), false;
    bitstream_ = bb.bitstreamBuffer;

    desc_ = std::string("NVENC native ") + (s.codec == Codec::H264 ? "H.264 " + s.h264Profile : "HEVC Main") + " P" +
            std::to_string(s.preset) + " ultra-low-latency CBR" + (s.nv12 ? " NV12" : " BGRA");
    if (s.codec == Codec::HEVC && s.splitMode >= 0) desc_ += " split=" + std::to_string(s.splitMode);
    return true;
}

bool Nvenc::registerInput(ID3D11Texture2D* tex, std::string& err) {
    NV_ENC_REGISTER_RESOURCE rr = {};
    rr.version = NV_ENC_REGISTER_RESOURCE_VER;
    rr.resourceType = NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX;
    rr.width = uint32_t(s_.width);
    rr.height = uint32_t(s_.height);
    rr.pitch = 0;
    rr.subResourceIndex = 0;
    rr.resourceToRegister = tex;
    rr.bufferFormat = s_.nv12 ? NV_ENC_BUFFER_FORMAT_NV12 : NV_ENC_BUFFER_FORMAT_ARGB;  // DXGI NV12 / B8G8R8A8
    rr.bufferUsage = NV_ENC_INPUT_IMAGE;
    NVENCSTATUS st = fn_.nvEncRegisterResource(enc_, &rr);
    if (st != NV_ENC_SUCCESS) return err = "register input: " + status(st), false;
    registered_ = rr.registeredResource;
    return true;
}

bool Nvenc::encode(uint64_t frameNo, bool forceIdr, const std::vector<uint8_t>& sei, std::vector<uint8_t>& out,
                   bool& isKeyframe, std::string& err) {
    NV_ENC_MAP_INPUT_RESOURCE mr = {};
    mr.version = NV_ENC_MAP_INPUT_RESOURCE_VER;
    mr.registeredResource = registered_;
    NVENCSTATUS st = fn_.nvEncMapInputResource(enc_, &mr);
    if (st != NV_ENC_SUCCESS) return err = "map input: " + status(st), false;

    NV_ENC_SEI_PAYLOAD payload = {};
    payload.payloadSize = uint32_t(sei.size());
    payload.payloadType = 5;  // user_data_unregistered
    payload.payload = const_cast<uint8_t*>(sei.data());

    NV_ENC_PIC_PARAMS pp = {};
    pp.version = NV_ENC_PIC_PARAMS_VER;
    pp.inputWidth = uint32_t(s_.width);
    pp.inputHeight = uint32_t(s_.height);
    pp.inputPitch = uint32_t(s_.width);
    pp.inputBuffer = mr.mappedResource;
    pp.bufferFmt = mr.mappedBufferFmt;
    pp.outputBitstream = bitstream_;
    pp.pictureStruct = NV_ENC_PIC_STRUCT_FRAME;
    pp.inputTimeStamp = frameNo;
    pp.encodePicFlags = forceIdr ? (NV_ENC_PIC_FLAG_FORCEIDR | NV_ENC_PIC_FLAG_OUTPUT_SPSPPS) : 0;
    if (!sei.empty()) {
        if (s_.codec == Codec::H264) {
            pp.codecPicParams.h264PicParams.seiPayloadArray = &payload;
            pp.codecPicParams.h264PicParams.seiPayloadArrayCnt = 1;
        } else {
            pp.codecPicParams.hevcPicParams.seiPayloadArray = &payload;
            pp.codecPicParams.hevcPicParams.seiPayloadArrayCnt = 1;
        }
    }
    st = fn_.nvEncEncodePicture(enc_, &pp);
    if (st != NV_ENC_SUCCESS) {
        fn_.nvEncUnmapInputResource(enc_, mr.mappedResource);
        return err = "encode: " + status(st), false;
    }

    NV_ENC_LOCK_BITSTREAM lb = {};
    lb.version = NV_ENC_LOCK_BITSTREAM_VER;
    lb.outputBitstream = bitstream_;
    st = fn_.nvEncLockBitstream(enc_, &lb);
    if (st != NV_ENC_SUCCESS) {
        fn_.nvEncUnmapInputResource(enc_, mr.mappedResource);
        return err = "lock bitstream: " + status(st), false;
    }
    const uint8_t* p = static_cast<const uint8_t*>(lb.bitstreamBufferPtr);
    out.assign(p, p + lb.bitstreamSizeInBytes);
    isKeyframe = lb.pictureType == NV_ENC_PIC_TYPE_IDR || lb.pictureType == NV_ENC_PIC_TYPE_I;
    fn_.nvEncUnlockBitstream(enc_, bitstream_);
    fn_.nvEncUnmapInputResource(enc_, mr.mappedResource);
    return true;
}
