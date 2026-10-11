#include "rtp.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <random>

namespace {
void putU32(uint8_t* p, uint32_t v) {
    p[0] = uint8_t(v >> 24);
    p[1] = uint8_t(v >> 16);
    p[2] = uint8_t(v >> 8);
    p[3] = uint8_t(v);
}
uint32_t getU32(const uint8_t* p) { return (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16) | (uint32_t(p[2]) << 8) | p[3]; }
void putF64(uint8_t* p, double d) {
    uint64_t v;
    memcpy(&v, &d, 8);
    for (int i = 0; i < 8; i++) p[i] = uint8_t(v >> (56 - 8 * i));
}
double getF64(const uint8_t* p) {
    uint64_t v = 0;
    for (int i = 0; i < 8; i++) v = (v << 8) | p[i];
    double d;
    memcpy(&d, &v, 8);
    return d;
}

/** Splits an Annex-B buffer into NAL units (start codes removed). */
std::vector<std::pair<const uint8_t*, size_t>> splitNals(const std::vector<uint8_t>& b) {
    std::vector<std::pair<const uint8_t*, size_t>> nals;
    const size_t n = b.size();
    size_t i = 0, start = SIZE_MAX;
    while (i + 3 <= n) {
        if (b[i] == 0 && b[i + 1] == 0 && (b[i + 2] == 1 || (i + 3 < n && b[i + 2] == 0 && b[i + 3] == 1))) {
            const size_t sc = b[i + 2] == 1 ? 3 : 4;
            if (start != SIZE_MAX) {
                size_t end = i;
                while (end > start && b[end - 1] == 0) end--;  // trailing zero bytes belong to the next start code
                nals.emplace_back(&b[start], end - start);
            }
            i += sc;
            start = i;
        } else {
            i++;
        }
    }
    if (start != SIZE_MAX && start < n) nals.emplace_back(&b[start], n - start);
    return nals;
}
}  // namespace

FrameSink::~FrameSink() {
    if (sock_ != INVALID_SOCKET) closesocket(sock_);
}

bool FrameSink::open(int port, std::string& err) {
    WSADATA wsa;
    WSAStartup(MAKEWORD(2, 2), &wsa);
    sock_ = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (sock_ == INVALID_SOCKET) return err = "socket() failed", false;
    BOOL nodelay = TRUE;
    setsockopt(sock_, IPPROTO_TCP, TCP_NODELAY, reinterpret_cast<const char*>(&nodelay), sizeof nodelay);
    int buf = 8 << 20;
    setsockopt(sock_, SOL_SOCKET, SO_SNDBUF, reinterpret_cast<const char*>(&buf), sizeof buf);
    sockaddr_in to = {};
    to.sin_family = AF_INET;
    to.sin_port = htons(uint16_t(port));
    inet_pton(AF_INET, "127.0.0.1", &to.sin_addr);
    if (connect(sock_, reinterpret_cast<sockaddr*>(&to), sizeof to) != 0) return err = "cannot connect to the desktop app frame port", false;
    return true;
}

bool FrameSink::send(const std::vector<uint8_t>& au, uint32_t frameNo, bool keyframe, double captureMs) {
    uint8_t h[24] = {'W', 'B', 'A', 'U'};
    const uint32_t len = uint32_t(au.size());
    memcpy(h + 4, &len, 4);
    memcpy(h + 8, &frameNo, 4);
    h[12] = keyframe ? 1 : 0;
    memcpy(h + 16, &captureMs, 8);
    WSABUF parts[2] = {{24, reinterpret_cast<char*>(h)}, {len, reinterpret_cast<char*>(const_cast<uint8_t*>(au.data()))}};
    DWORD sent = 0;
    return WSASend(sock_, parts, 2, &sent, 0, nullptr, nullptr) == 0 && sent == 24 + len;
}

RtpSender::~RtpSender() {
    running_ = false;
    if (sock_ != INVALID_SOCKET) closesocket(sock_);
    if (rx_.joinable()) rx_.join();
    WSACleanup();
}

bool RtpSender::open(const std::string& ip, int port, std::string& err) {
    WSADATA wsa;
    WSAStartup(MAKEWORD(2, 2), &wsa);
    sock_ = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (sock_ == INVALID_SOCKET) return err = "socket() failed", false;
    int buf = 8 << 20;
    setsockopt(sock_, SOL_SOCKET, SO_SNDBUF, reinterpret_cast<const char*>(&buf), sizeof buf);
    setsockopt(sock_, SOL_SOCKET, SO_RCVBUF, reinterpret_cast<const char*>(&buf), sizeof buf);
    sockaddr_in to = {};
    to.sin_family = AF_INET;
    to.sin_port = htons(uint16_t(port));
    if (inet_pton(AF_INET, ip.c_str(), &to.sin_addr) != 1) return err = "bad TV address " + ip, false;
    // connect() fixes the peer, so the receive loop only sees the TV's replies.
    if (connect(sock_, reinterpret_cast<sockaddr*>(&to), sizeof to) != 0) return err = "connect() failed", false;
    std::random_device rd;
    ssrc_ = rd();
    seq_ = uint16_t(rd());
    pkt_.resize(12 + 2 + size_t(mtu) + 16);
    running_ = true;
    rx_ = std::thread([this] { receiveLoop(); });
    return true;
}

void RtpSender::receiveLoop() {
    uint8_t b[1500];
    DWORD timeout = 200;
    setsockopt(sock_, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&timeout), sizeof timeout);
    while (running_) {
        int n = recv(sock_, reinterpret_cast<char*>(b), sizeof b, 0);
        if (n <= 0) continue;
        const double t1 = nowMs();
        if (n >= 24 && memcmp(b, "WBPO", 4) == 0) {
            std::lock_guard<std::mutex> lk(pongMu_);
            pongSeq_ = getU32(b + 4);
            pongT0_ = getF64(b + 8);
            pongTv_ = getF64(b + 16);
            pongT1_ = t1;
            pongCv_.notify_all();
        } else if (n >= 4 && memcmp(b, "WBKF", 4) == 0) {
            keyframeRequests++;
            keyframeWanted = true;
        } else if (n >= 12 && memcmp(b, "WBPH", 4) == 0) {
            const double shift = getF64(b + 4);
            if (std::isfinite(shift)) {
                double cur = phaseShiftMs.load();
                while (!phaseShiftMs.compare_exchange_weak(cur, cur + shift)) {
                }
            }
        }
    }
}

bool RtpSender::clockSync(int rounds, double& offsetMs, double& rttMs, std::string& err) {
    double bestRtt = 1e9, bestOffset = 0;
    for (int i = 0; i < rounds; i++) {
        uint8_t ping[16];
        memcpy(ping, "WBPI", 4);
        const uint32_t seq = uint32_t(i + 1);
        putU32(ping + 4, seq);
        const double t0 = nowMs();
        putF64(ping + 8, t0);
        send(sock_, reinterpret_cast<const char*>(ping), sizeof ping, 0);
        std::unique_lock<std::mutex> lk(pongMu_);
        if (pongCv_.wait_for(lk, std::chrono::milliseconds(300), [&] { return pongSeq_ == seq; })) {
            const double rtt = pongT1_ - pongT0_;
            if (rtt < bestRtt) {
                bestRtt = rtt;
                bestOffset = pongTv_ - (pongT0_ + pongT1_) / 2;
            }
        }
        lk.unlock();
        Sleep(10);
    }
    if (bestRtt >= 1e9) return err = "no clock-sync reply from the TV (is the native receiver running?)", false;
    offsetMs = bestOffset;
    rttMs = bestRtt;
    return true;
}

void RtpSender::sendPacket(const uint8_t* payload, size_t len, bool marker, uint32_t ts, const uint8_t* prefix, size_t prefixLen) {
    uint8_t* p = pkt_.data();
    p[0] = 0x80;
    p[1] = uint8_t((marker ? 0x80 : 0) | payloadType_);
    p[2] = uint8_t(seq_ >> 8);
    p[3] = uint8_t(seq_);
    seq_++;
    putU32(p + 4, ts);
    putU32(p + 8, ssrc_);
    memcpy(p + 12, prefix, prefixLen);
    memcpy(p + 12 + prefixLen, payload, len);
    const int total = int(12 + prefixLen + len);
    send(sock_, reinterpret_cast<const char*>(p), total, 0);
    bytesSent += uint64_t(total);
    packetsSent++;
}

int RtpSender::sendAccessUnit(const std::vector<uint8_t>& au, Codec codec, uint32_t ts) {
    payloadType_ = codec == Codec::H264 ? 96 : 97;
    const auto nals = splitNals(au);
    int sent = 0;
    for (size_t k = 0; k < nals.size(); k++) {
        const uint8_t* nal = nals[k].first;
        const size_t size = nals[k].second;
        const bool lastNal = k + 1 == nals.size();
        if (size <= size_t(mtu)) {
            sendPacket(nal, size, lastNal, ts, nullptr, 0);
            sent++;
            continue;
        }
        if (codec == Codec::H264) {
            // FU-A: indicator keeps F/NRI, type 28; header carries S/E and the original type.
            const uint8_t type = nal[0] & 0x1F;
            uint8_t prefix[2] = {uint8_t((nal[0] & 0xE0) | 28), 0};
            size_t off = 1;
            while (off < size) {
                const size_t chunk = std::min(size - off, size_t(mtu) - 2);
                const bool first = off == 1, last = off + chunk == size;
                prefix[1] = uint8_t((first ? 0x80 : 0) | (last ? 0x40 : 0) | type);
                sendPacket(nal + off, chunk, lastNal && last, ts, prefix, 2);
                off += chunk;
                sent++;
            }
        } else {
            // HEVC FU (type 49): 2-byte payload header + 1-byte FU header.
            const uint8_t type = (nal[0] >> 1) & 0x3F;
            uint8_t prefix[3] = {uint8_t((nal[0] & 0x81) | (49 << 1)), nal[1], 0};
            size_t off = 2;
            while (off < size) {
                const size_t chunk = std::min(size - off, size_t(mtu) - 3);
                const bool first = off == 2, last = off + chunk == size;
                prefix[2] = uint8_t((first ? 0x80 : 0) | (last ? 0x40 : 0) | type);
                sendPacket(nal + off, chunk, lastNal && last, ts, prefix, 3);
                off += chunk;
                sent++;
            }
        }
    }
    return sent;
}
