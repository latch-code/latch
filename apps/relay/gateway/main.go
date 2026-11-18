// The public TLS boundary uses only the Go standard library. The Node backend is a
// private Unix socket; source addresses are never trusted from HTTP headers.
package main

import (
	"bufio"
	"bytes"
	"container/list"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/netip"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

func decodeStrict(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return errors.New("Invalid trailing input")
	}
	return nil
}

type config struct {
	Host                string  `json:"host"`
	Port                int     `json:"port"`
	Backend             string  `json:"backend"`
	Certificate         string  `json:"certificate"`
	Key                 string  `json:"key"`
	MaxConnections      int     `json:"maxConnections"`
	MaxHandshakes       int     `json:"maxHandshakes"`
	HandshakesPerSecond float64 `json:"handshakesPerSecond"`
	HandshakeBurst      float64 `json:"handshakeBurst"`
	PrefixFraction      float64 `json:"prefixFraction"`
}
type bucket struct {
	tokens  float64
	at      time.Time
	active  int
	pending int
	idle    *list.Element
}
type gateway struct {
	cfg         config
	listener    net.Listener
	mu          sync.Mutex
	connections map[net.Conn]struct{}
	groups      map[netip.Prefix]*bucket
	idle        *list.List
	global      bucket
	handshakes  int
	draining    bool
	rejected    atomic.Uint64
	bytes       atomic.Uint64
	output      sync.Mutex
	wg          sync.WaitGroup
}

func (g *gateway) emit(value any) {
	g.output.Lock()
	defer g.output.Unlock()
	_ = json.NewEncoder(os.Stdout).Encode(value)
}
func valid(c config) bool {
	return net.ParseIP(c.Host) != nil && c.Port >= 0 && c.Port <= 65535 && filepath.IsAbs(c.Backend) && len(c.Backend) <= 100 &&
		c.MaxConnections >= 1 && c.MaxConnections <= 20000 && c.MaxHandshakes >= 1 && c.MaxHandshakes <= 4096 && c.MaxHandshakes <= c.MaxConnections &&
		c.HandshakesPerSecond >= 1 && c.HandshakesPerSecond <= 100000 && c.HandshakeBurst >= 1 && c.HandshakeBurst <= float64(c.MaxHandshakes) &&
		c.PrefixFraction > 0 && c.PrefixFraction <= 1 && c.PrefixFraction*float64(c.MaxConnections) >= 1 && c.PrefixFraction*float64(c.MaxHandshakes) >= 1
}
func privateBackend(path string) bool {
	info, err := os.Lstat(path)
	if err != nil || info.Mode()&os.ModeSocket == 0 || info.Mode().Perm()&0077 != 0 {
		return false
	}
	parent, err := os.Lstat(filepath.Dir(path))
	return err == nil && parent.IsDir() && parent.Mode()&os.ModeSymlink == 0 && parent.Mode().Perm()&0077 == 0
}
func prefixGroups(addr netip.Addr) []netip.Prefix {
	addr = addr.Unmap()
	sizes := []int{24, 32}
	if addr.Is6() {
		sizes = []int{32, 48, 56, 64}
	}
	result := make([]netip.Prefix, 0, len(sizes))
	for _, n := range sizes {
		result = append(result, netip.PrefixFrom(addr, n).Masked())
	}
	return result
}
func credit(b *bucket, rate, burst float64, now time.Time) {
	elapsed := now.Sub(b.at).Seconds()
	b.tokens = min(burst, b.tokens+max(0, elapsed)*rate)
	b.at = now
}
func (g *gateway) fraction(prefix netip.Prefix) float64 {
	// A /32 is an aggregate IPv6 fence; independent /48 tenants still retain their shares.
	if prefix.Addr().Is6() && prefix.Bits() == 32 {
		return 1
	}
	return g.cfg.PrefixFraction
}
func (g *gateway) admit(raw net.Conn, now time.Time) ([]netip.Prefix, bool) {
	tcp, ok := raw.RemoteAddr().(*net.TCPAddr)
	if !ok {
		return nil, false
	}
	addr, ok := netip.AddrFromSlice(tcp.IP)
	if !ok {
		return nil, false
	}
	groups := prefixGroups(addr)
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.draining || len(g.connections) >= g.cfg.MaxConnections || g.handshakes >= g.cfg.MaxHandshakes {
		return nil, false
	}
	credit(&g.global, g.cfg.HandshakesPerSecond, g.cfg.HandshakeBurst, now)
	if g.global.tokens < 1 {
		return nil, false
	}
	existing := make([]*bucket, len(groups))
	missing := 0
	idle := g.idle.Len()
	for i, p := range groups {
		b := g.groups[p]
		existing[i] = b
		if b == nil {
			missing++
			continue
		}
		fraction := g.fraction(p)
		credit(b, g.cfg.HandshakesPerSecond*fraction, max(1, g.cfg.HandshakeBurst*fraction), now)
		if b.idle != nil {
			g.idle.MoveToBack(b.idle)
			idle--
		}
		if b.tokens < 1 || b.pending >= int(float64(g.cfg.MaxHandshakes)*fraction) || b.active >= int(float64(g.cfg.MaxConnections)*fraction) {
			return nil, false
		}
	}
	if g.cfg.MaxConnections*4-len(g.groups)+idle < missing {
		return nil, false
	}
	// Reserve existing entries before eviction so a shared prefix cannot be replaced mid-admission.
	for _, b := range existing {
		if b != nil {
			if b.idle != nil {
				g.idle.Remove(b.idle)
				b.idle = nil
			}
			b.tokens--
			b.active++
			b.pending++
		}
	}
	for i, p := range groups {
		if existing[i] == nil {
			for len(g.groups) >= g.cfg.MaxConnections*4 {
				old := g.idle.Front()
				prefix := old.Value.(netip.Prefix)
				g.idle.Remove(old)
				delete(g.groups, prefix)
			}
			g.groups[p] = &bucket{tokens: max(1, g.cfg.HandshakeBurst*g.fraction(p)) - 1, at: now, active: 1, pending: 1}
		}
	}
	g.global.tokens--
	g.connections[raw] = struct{}{}
	g.handshakes++
	return groups, true
}
func (g *gateway) release(raw net.Conn, groups []netip.Prefix) {
	g.mu.Lock()
	defer g.mu.Unlock()
	delete(g.connections, raw)
	for _, p := range groups {
		if b := g.groups[p]; b != nil {
			b.active--
			if b.active == 0 {
				b.idle = g.idle.PushBack(p)
			}
		}
	}
}
func proxyHeader(source, destination net.Addr) ([]byte, error) {
	src, ok := source.(*net.TCPAddr)
	if !ok {
		return nil, errors.New("address")
	}
	dst, ok := destination.(*net.TCPAddr)
	if !ok {
		return nil, errors.New("address")
	}
	sip, ok := netip.AddrFromSlice(src.IP)
	if !ok {
		return nil, errors.New("address")
	}
	dip, ok := netip.AddrFromSlice(dst.IP)
	if !ok {
		return nil, errors.New("address")
	}
	sip = sip.Unmap()
	dip = dip.Unmap()
	family := byte(0x11)
	size := 12
	if sip.Is6() {
		family = 0x21
		size = 36
	}
	if sip.Is4() != dip.Is4() {
		return nil, errors.New("address")
	}
	result := make([]byte, 16+size)
	copy(result, []byte("\r\n\r\n\x00\r\nQUIT\n"))
	result[12] = 0x21
	result[13] = family
	binary.BigEndian.PutUint16(result[14:16], uint16(size))
	n := 4
	if sip.Is6() {
		n = 16
	}
	copy(result[16:16+n], sip.AsSlice())
	copy(result[16+n:16+2*n], dip.AsSlice())
	binary.BigEndian.PutUint16(result[16+2*n:], uint16(src.Port))
	binary.BigEndian.PutUint16(result[18+2*n:], uint16(dst.Port))
	return result, nil
}

type onlyReader struct{ io.Reader }
type boundedWriter struct {
	target net.Conn
	count  *atomic.Uint64
}

func (w boundedWriter) Write(p []byte) (int, error) {
	_ = w.target.SetWriteDeadline(time.Now().Add(60 * time.Second))
	n, err := w.target.Write(p)
	w.count.Add(uint64(n))
	return n, err
}
func (g *gateway) handshakeFinished(groups []netip.Prefix) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.handshakes--
	for _, p := range groups {
		g.groups[p].pending--
	}
}
func configureRelayTCP(raw net.Conn) error {
	tcp, ok := raw.(*net.TCPConn)
	if !ok {
		return errors.New("Invalid TCP connection")
	}
	return tcp.SetKeepAliveConfig(net.KeepAliveConfig{Enable: true, Idle: 60 * time.Second, Interval: 15 * time.Second, Count: 4})
}
func (g *gateway) serve(raw net.Conn, groups []netip.Prefix, cfg *tls.Config) {
	defer g.wg.Done()
	defer raw.Close()
	defer g.release(raw, groups)
	if configureRelayTCP(raw) != nil {
		g.handshakeFinished(groups)
		return
	}
	secure := tls.Server(raw, cfg)
	_ = raw.SetDeadline(time.Now().Add(5 * time.Second))
	err := secure.Handshake()
	g.handshakeFinished(groups)
	if err != nil || secure.ConnectionState().DidResume {
		return
	}
	_ = raw.SetDeadline(time.Time{})
	if !privateBackend(g.cfg.Backend) {
		return
	}
	backend, err := net.DialTimeout("unix", g.cfg.Backend, 3*time.Second)
	if err != nil {
		return
	}
	defer backend.Close()
	header, err := proxyHeader(raw.RemoteAddr(), raw.LocalAddr())
	if err != nil {
		return
	}
	_ = backend.SetWriteDeadline(time.Now().Add(3 * time.Second))
	if _, err = backend.Write(header); err != nil {
		return
	}
	_ = backend.SetWriteDeadline(time.Time{})
	copyUntilClosed := func(to, from net.Conn) {
		_, _ = io.CopyBuffer(boundedWriter{to, &g.bytes}, onlyReader{from}, make([]byte, 16*1024))
		// The other side may still be waiting for bytes after this side disconnected.
		_ = raw.Close()
		_ = backend.Close()
	}
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		copyUntilClosed(backend, secure)
	}()
	copyUntilClosed(secure, backend)
	<-finished
}
func (g *gateway) stop(force bool) {
	g.mu.Lock()
	g.draining = true
	if force {
		for c := range g.connections {
			_ = c.Close()
		}
	}
	g.mu.Unlock()
	_ = g.listener.Close()
}
func main() {
	if len(os.Args) == 2 && os.Args[1] == "supervise" {
		runSupervisor()
		return
	}
	if len(os.Args) == 2 && os.Args[1] == "version" {
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"protocol": 2, "go": runtime.Version()})
		return
	}
	// PEMs arrive on stdin, never arguments, environment variables, URLs or logs.
	reader := bufio.NewReaderSize(os.Stdin, 64*1024+1)
	line, err := reader.ReadSlice('\n')
	if err != nil || len(line) > 64*1024 {
		os.Exit(1)
	}
	var c config
	if decodeStrict(line, &c) != nil || !valid(c) || !privateBackend(c.Backend) {
		os.Exit(1)
	}
	certificate, err := tls.X509KeyPair([]byte(c.Certificate), []byte(c.Key))
	if err != nil {
		os.Exit(1)
	}
	c.Certificate = ""
	c.Key = ""
	leaf, err := x509.ParseCertificate(certificate.Certificate[0])
	if err != nil {
		os.Exit(1)
	}
	activeCertificate := &certificate
	var certificateMu sync.RWMutex
	cfg := &tls.Config{GetCertificate: func(_ *tls.ClientHelloInfo) (*tls.Certificate, error) {
		certificateMu.RLock()
		defer certificateMu.RUnlock()
		return activeCertificate, nil
	}, MinVersion: tls.VersionTLS13, MaxVersion: tls.VersionTLS13, SessionTicketsDisabled: true, NextProtos: []string{"http/1.1"}}
	listener, err := net.Listen("tcp", net.JoinHostPort(c.Host, strconv.Itoa(c.Port)))
	if err != nil {
		os.Exit(1)
	}
	g := &gateway{cfg: c, listener: listener, connections: make(map[net.Conn]struct{}), groups: make(map[netip.Prefix]*bucket), idle: list.New(), global: bucket{tokens: c.HandshakeBurst, at: time.Now()}}
	g.emit(map[string]any{"event": "ready", "port": listener.Addr().(*net.TCPAddr).Port, "protocol": 2})
	done := make(chan struct{})
	defer close(done)
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case now := <-ticker.C:
				g.mu.Lock()
				active := len(g.connections)
				pending := g.handshakes
				for p, b := range g.groups {
					if b.active == 0 && now.Sub(b.at) > time.Minute {
						if b.idle != nil {
							g.idle.Remove(b.idle)
						}
						delete(g.groups, p)
					}
				}
				g.mu.Unlock()
				g.emit(map[string]any{"event": "heartbeat", "connections": active, "handshakes": pending, "rejected": g.rejected.Load(), "forwardedBytes": g.bytes.Load()})
			case <-done:
				return
			}
		}
	}()
	go func() {
		for {
			command, e := reader.ReadSlice('\n')
			if e != nil || len(command) > 64*1024 {
				g.stop(true)
				return
			}
			if strings.TrimSpace(string(command)) == `{"command":"drain"}` {
				g.stop(false)
			} else if strings.TrimSpace(string(command)) == `{"command":"stop"}` {
				g.stop(true)
				return
			} else {
				var request struct {
					Command     string `json:"command"`
					Generation  uint32 `json:"generation"`
					Certificate string `json:"certificate"`
					Key         string `json:"key"`
				}
				if decodeStrict(command, &request) != nil || request.Command != "reload-tls" || request.Generation == 0 {
					g.stop(true)
					return
				}
				next, err := tls.X509KeyPair([]byte(request.Certificate), []byte(request.Key))
				accepted := false
				if err == nil {
					if nextLeaf, e := x509.ParseCertificate(next.Certificate[0]); e == nil && bytes.Equal(leaf.RawSubjectPublicKeyInfo, nextLeaf.RawSubjectPublicKeyInfo) && time.Now().Before(nextLeaf.NotAfter) && !time.Now().Before(nextLeaf.NotBefore) {
						certificateMu.Lock()
						activeCertificate = &next
						certificateMu.Unlock()
						accepted = true
					}
				}
				g.emit(map[string]any{"event": "tls-reloaded", "generation": request.Generation, "accepted": accepted})
			}
		}
	}()
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(signals)
	go func() {
		select {
		case <-signals:
			g.stop(true)
		case <-done:
		}
	}()
	for {
		raw, e := listener.Accept()
		if e != nil {
			break
		}
		groups, ok := g.admit(raw, time.Now())
		if !ok {
			g.rejected.Add(1)
			_ = raw.Close()
			continue
		}
		g.wg.Add(1)
		go g.serve(raw, groups, cfg)
	}
	g.wg.Wait()
}
