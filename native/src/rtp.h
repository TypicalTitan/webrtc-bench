// RTP over UDP to the TV (RFC 6184 H.264 FU-A, RFC 7798 HEVC FU), plus the tiny side
// protocol on the same socket: clock-sync ping/pong, keyframe requests (WBKF) and frame-clock
// phase shifts (WBPH) from the TV's vsync pacer.
#pragma once

#include "common.h"

#include <winsock2.h>
#include <ws2tcpip.h>

#include <atomic>
#include <condition_variable>
#include <mutex>
#include <thread>
#include <vector>

/**
 * Encoded frames to the desktop app over a loopback TCP connection (cloud-gaming profile: the
 * app sends them over WebRTC). Each frame: "WBAU", u32 payload bytes, u32 frame number, u8
 * keyframe, 3 bytes padding, f64 capture time (QueryPerformanceCounter ms; NaN = repeated
 * screen content), then the Annex-B access unit. Little-endian.
 */
class FrameSink {
public:
    ~FrameSink();
    bool open(int port, std::string& err);
    bool send(const std::vector<uint8_t>& au, uint32_t frameNo, bool keyframe, double captureMs);

private:
    SOCKET sock_ = INVALID_SOCKET;
};

class RtpSender {
public:
    ~RtpSender();
    bool open(const std::string& ip, int port, std::string& err);
    /** Min-RTT ping/pong against the TV: offset = tvClock - ourClock. */
    bool clockSync(int rounds, double& offsetMs, double& rttMs, std::string& err);
    /** Packetizes one Annex-B access unit; returns packets sent. */
    int sendAccessUnit(const std::vector<uint8_t>& au, Codec codec, uint32_t rtpTimestamp);

    std::atomic<int> keyframeRequests{0};
    std::atomic<bool> keyframeWanted{false};
    /** Accumulated frame-clock shift requested by the TV (ms, positive = send later); take with exchange(0). */
    std::atomic<double> phaseShiftMs{0.0};
    uint64_t bytesSent = 0;
    uint64_t packetsSent = 0;
    int mtu = 1200;

private:
    void receiveLoop();
    void sendPacket(const uint8_t* payload, size_t len, bool marker, uint32_t ts, const uint8_t* prefix, size_t prefixLen);

    SOCKET sock_ = INVALID_SOCKET;
    std::thread rx_;
    std::atomic<bool> running_{false};
    uint16_t seq_ = 0;
    uint32_t ssrc_ = 0;
    uint8_t payloadType_ = 96;
    std::vector<uint8_t> pkt_;

    std::mutex pongMu_;
    std::condition_variable pongCv_;
    uint32_t pongSeq_ = 0;
    double pongT0_ = 0, pongTv_ = 0, pongT1_ = 0;
};
