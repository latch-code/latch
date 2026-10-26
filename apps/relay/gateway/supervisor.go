package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
)

type supervisorConfig struct {
	DataDir   string   `json:"dataDir"`
	Node      string   `json:"node"`
	Args      []string `json:"args"`
	AdminPort int      `json:"adminPort"`
}
type restartLedger struct {
	Version       int    `json:"version"`
	Restarts      uint64 `json:"restarts"`
	LastFailure   string `json:"lastFailure"`
	LastRestartAt int64  `json:"lastRestartAt"`
}
type workerMessage struct {
	Type        string          `json:"type"`
	Port        int             `json:"port,omitempty"`
	AdminPort   int             `json:"adminPort,omitempty"`
	AdminSocket string          `json:"adminSocket,omitempty"`
	Status      json.RawMessage `json:"status,omitempty"`
	Signature   string          `json:"signature,omitempty"`
}
type supervisor struct {
	mu             sync.Mutex
	cfg            supervisorConfig
	listener       net.Listener
	worker         *exec.Cmd
	input          io.WriteCloser
	adminPort      int
	adminSocket    string
	heartbeat      time.Time
	status         map[string]json.RawMessage
	draining       bool
	state          string
	currentFailure string
	ledger         restartLedger
	commands       chan string
	output         sync.Mutex
}

func (s *supervisor) emit(value any) {
	s.output.Lock()
	defer s.output.Unlock()
	_ = json.NewEncoder(os.Stdout).Encode(value)
}
func (s *supervisor) persist(ledger restartLedger) error {
	text, err := json.Marshal(ledger)
	if err != nil {
		return err
	}
	target := filepath.Join(s.cfg.DataDir, "restarts.json")
	if old, e := os.Lstat(target); e == nil {
		if !old.Mode().IsRegular() || old.Mode().Perm()&0077 != 0 {
			return errors.New("state")
		}
	} else if !os.IsNotExist(e) {
		return e
	}
	file, err := os.CreateTemp(s.cfg.DataDir, ".restarts-*.tmp")
	if err != nil {
		return err
	}
	name := file.Name()
	defer os.Remove(name)
	if file.Chmod(0600) != nil {
		file.Close()
		return errors.New("state")
	}
	if _, err = file.Write(append(text, '\n')); err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = os.Rename(name, target); err != nil {
		return err
	}
	dir, err := os.Open(s.cfg.DataDir)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}
func loadRestarts(path string) (restartLedger, error) {
	result := restartLedger{Version: 1}
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return result, nil
	}
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > 1024 {
		return result, errors.New("state")
	}
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return result, err
	}
	defer file.Close()
	data, readErr := io.ReadAll(io.LimitReader(file, 1025))
	if readErr != nil || len(data) > 1024 {
		return result, errors.New("state")
	}
	if decodeStrict(data, &result) != nil || result.Version != 1 || result.LastRestartAt < 0 || len(result.LastFailure) != 64 {
		return result, errors.New("state")
	}
	if _, err = hex.DecodeString(result.LastFailure); err != nil {
		return result, errors.New("state")
	}
	return result, nil
}
func (s *supervisor) handle(w http.ResponseWriter, r *http.Request, private bool) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	if ((!private && r.Host != s.listener.Addr().String()) || (private && r.Host != "latch-relay-admin")) || r.Header.Get("Origin") != "" || r.Header.Get("Sec-Fetch-Site") != "" {
		w.WriteHeader(403)
		_, _ = w.Write([]byte("{}"))
		return
	}
	s.mu.Lock()
	state := s.state
	draining := s.draining
	fresh := time.Since(s.heartbeat) <= 10*time.Second
	ready := string(s.status["ready"]) == "true"
	socket := s.adminSocket
	ledger := s.ledger
	snapshot := make(map[string]any)
	for key, value := range s.status {
		snapshot[key] = value
	}
	s.mu.Unlock()
	if r.Method == "GET" && r.URL.Path == "/healthz" {
		if state != "running" || draining || !fresh || !ready {
			w.WriteHeader(503)
		}
		_, _ = w.Write([]byte("{}"))
		return
	}
	if r.Method == "GET" && r.URL.Path == "/status" {
		snapshot["supervisor"] = map[string]any{"state": state, "draining": draining, "heartbeatHealthy": fresh, "restarts": ledger.Restarts, "lastFailure": ledger.LastFailure, "lastRestartAt": ledger.LastRestartAt, "go": runtime.Version()}
		_ = json.NewEncoder(w).Encode(snapshot)
		return
	}
	if !private || r.Method != "POST" || r.Header.Get("x-latch-relay-admin") != "1" || (r.URL.Path != "/drain" && r.URL.Path != "/quota" && r.URL.Path != "/reload") || len(r.TransferEncoding) != 0 || r.ContentLength < 0 || r.ContentLength > 128 {
		w.WriteHeader(404)
		_, _ = w.Write([]byte("{}"))
		return
	}
	if r.URL.Path == "/drain" {
		select {
		case s.commands <- "drain":
		default:
		}
		_, _ = w.Write([]byte(`{"draining":true}`))
		return
	}
	if socket == "" || state != "running" {
		w.WriteHeader(503)
		_, _ = w.Write([]byte("{}"))
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 129))
	if err != nil || len(body) > 128 {
		w.WriteHeader(400)
		return
	}
	target := "http://latch-relay-admin" + r.URL.Path
	request, err := http.NewRequest("POST", target, bytes.NewReader(body))
	if err != nil {
		w.WriteHeader(400)
		return
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("x-latch-relay-admin", "1")
	client := &http.Client{Timeout: 3 * time.Second, Transport: &http.Transport{DisableKeepAlives: true, DialContext: func(_ context.Context, _, _ string) (net.Conn, error) {
		return net.DialTimeout("unix", socket, 3*time.Second)
	}}}
	response, err := client.Do(request)
	if err != nil {
		w.WriteHeader(503)
		_, _ = w.Write([]byte(`{"unknown":true}`))
		return
	}
	defer response.Body.Close()
	output, err := io.ReadAll(io.LimitReader(response.Body, 32769))
	if err != nil || len(output) > 32768 {
		w.WriteHeader(503)
		return
	}
	w.WriteHeader(response.StatusCode)
	_, _ = w.Write(output)
}
func (s *supervisor) start(lock *os.File) (<-chan error, error) {
	command := exec.Command(s.cfg.Node, s.cfg.Args...)
	command.Env = []string{"PATH=/usr/bin:/bin", "NODE_ENV=production"}
	command.ExtraFiles = []*os.File{lock}
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return nil, err
	}
	input, err := command.StdinPipe()
	if err != nil {
		return nil, err
	}
	command.Stderr = io.Discard
	if err = command.Start(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	s.worker = command
	s.input = input
	s.heartbeat = time.Now()
	s.status = nil
	s.adminPort = 0
	s.adminSocket = ""
	s.state = "starting"
	s.currentFailure = ""
	s.mu.Unlock()
	go func() {
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 4096), 65536)
		for scanner.Scan() {
			var message workerMessage
			if decodeStrict(scanner.Bytes(), &message) != nil {
				_ = command.Process.Kill()
				return
			}
			if message.Type == "fatal" {
				if _, decodeErr := hex.DecodeString(message.Signature); len(message.Signature) != 64 || decodeErr != nil {
					_ = command.Process.Kill()
					return
				}
				s.mu.Lock()
				s.currentFailure = message.Signature
				s.mu.Unlock()
				continue
			}
			if message.Type != "ready" && message.Type != "heartbeat" {
				_ = command.Process.Kill()
				return
			}
			var status map[string]json.RawMessage
			if json.Unmarshal(message.Status, &status) != nil || len(status) > 16 {
				_ = command.Process.Kill()
				return
			}
			for key := range status {
				switch key {
				case "connections", "routes", "pending", "controls", "withoutAlternate", "certificate", "runtime", "draining", "ready", "denials", "memory", "quota", "forwarding", "gateway", "registrationWork":
				default:
					_ = command.Process.Kill()
					return
				}
			}
			for _, dependency := range []string{"gateway", "denials"} {
				if value, exists := status[dependency]; exists {
					var health struct {
						Healthy bool `json:"healthy"`
					}
					if json.Unmarshal(value, &health) != nil || !health.Healthy {
						_ = command.Process.Kill()
						return
					}
				}
			}
			s.mu.Lock()
			if s.worker != command {
				s.mu.Unlock()
				return
			}
			s.heartbeat = time.Now()
			s.status = status
			if message.Type == "ready" {
				if !privateBackend(message.AdminSocket) || message.Port < 1 || message.Port > 65535 {
					s.mu.Unlock()
					_ = command.Process.Kill()
					return
				}
				s.adminPort = message.AdminPort
				s.adminSocket = message.AdminSocket
				s.state = "running"
			}
			s.mu.Unlock()
			if message.Type == "ready" {
				s.emit(map[string]any{"started": true, "port": message.Port, "adminPort": s.listener.Addr().(*net.TCPAddr).Port})
			}
		}
		if scanner.Err() != nil {
			_ = command.Process.Kill()
		}
	}()
	finished := make(chan error, 1)
	go func() { err := command.Wait(); _ = input.Close(); finished <- err }()
	return finished, nil
}
func (s *supervisor) kill() {
	s.mu.Lock()
	worker := s.worker
	s.mu.Unlock()
	if worker != nil && worker.Process != nil {
		_ = worker.Process.Kill()
	}
}
func (s *supervisor) drain() {
	s.mu.Lock()
	if s.draining {
		s.mu.Unlock()
		return
	}
	s.draining = true
	s.state = "draining"
	input := s.input
	s.mu.Unlock()
	if input != nil {
		_, _ = io.WriteString(input, "{\"command\":\"drain\"}\n")
	}
}
func (s *supervisor) waitDrained(signals <-chan os.Signal) {
	s.mu.Lock()
	s.state = "drained"
	s.mu.Unlock()
	for {
		select {
		case <-signals:
			return
		case command := <-s.commands:
			if command != "drain" {
				return
			}
		}
	}
}
func runSupervisor() {
	reader := bufio.NewReaderSize(os.Stdin, 65537)
	line, err := reader.ReadSlice('\n')
	if err != nil || len(line) > 65536 {
		os.Exit(1)
	}
	var config supervisorConfig
	if decodeStrict(line, &config) != nil || !filepath.IsAbs(config.DataDir) || !filepath.IsAbs(config.Node) || len(config.Args) > 16 || config.AdminPort < 0 || config.AdminPort > 65535 {
		os.Exit(1)
	}
	info, err := os.Lstat(config.DataDir)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0077 != 0 {
		os.Exit(1)
	}
	lock, err := os.OpenFile(filepath.Join(config.DataDir, "relay.lock"), os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		os.Exit(1)
	}
	defer lock.Close()
	info, err = lock.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) != nil {
		os.Exit(1)
	}
	entries, err := os.ReadDir(config.DataDir)
	if err != nil {
		os.Exit(1)
	}
	ownedTemporary := regexp.MustCompile(`^\.restarts-[0-9]+\.tmp$`)
	for _, entry := range entries {
		if ownedTemporary.MatchString(entry.Name()) {
			info, e := entry.Info()
			if e != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > 1024 {
				os.Exit(1)
			}
			if os.Remove(filepath.Join(config.DataDir, entry.Name())) != nil {
				os.Exit(1)
			}
		}
	}
	ledger, err := loadRestarts(filepath.Join(config.DataDir, "restarts.json"))
	if err != nil {
		os.Exit(1)
	}
	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", config.AdminPort))
	if err != nil {
		os.Exit(1)
	}
	defer listener.Close()
	s := &supervisor{cfg: config, listener: listener, state: "starting", ledger: ledger, commands: make(chan string, 2)}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { s.handle(w, r, false) }), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: 5 * time.Second, MaxHeaderBytes: 4096}
	go func() { _ = server.Serve(listener) }()
	defer server.Close()
	adminPath := filepath.Join(config.DataDir, "admin.sock")
	if len(adminPath) > 100 {
		os.Exit(1)
	}
	if old, e := os.Lstat(adminPath); e == nil {
		if old.Mode()&os.ModeSocket == 0 || old.Mode().Perm()&0077 != 0 {
			os.Exit(1)
		}
		if os.Remove(adminPath) != nil {
			os.Exit(1)
		}
	} else if !os.IsNotExist(e) {
		os.Exit(1)
	}
	privateListener, e := net.Listen("unix", adminPath)
	if e != nil {
		os.Exit(1)
	}
	defer privateListener.Close()
	if os.Chmod(adminPath, 0600) != nil {
		os.Exit(1)
	}
	privateServer := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { s.handle(w, r, true) }), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: 5 * time.Second, MaxHeaderBytes: 4096}
	go func() { _ = privateServer.Serve(privateListener) }()
	defer privateServer.Close()
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(signals)
	go func() {
		for {
			line, e := reader.ReadSlice('\n')
			if e != nil {
				select {
				case s.commands <- "stop":
				default:
				}
				return
			}
			if strings.TrimSpace(string(line)) == `{"command":"shutdown"}` {
				select {
				case s.commands <- "shutdown":
				default:
				}
			} else if strings.TrimSpace(string(line)) == `{"command":"drain"}` {
				select {
				case s.commands <- "drain":
				default:
				}
			} else {
				select {
				case s.commands <- "stop":
				default:
				}
				return
			}
		}
	}()
	failures := 0
	for {
		finished, startErr := s.start(lock)
		if startErr != nil {
			finished = make(chan error)
		}
		ticker := time.NewTicker(time.Second)
		reason := "worker-exit"
		stopping := false
		hold := false
		settled := false
		var drainDeadline time.Time
		if startErr != nil {
			reason = "worker-start"
		} else {
		running:
			for {
				select {
				case <-signals:
					hold = false
					s.drain()
					stopping = true
					drainDeadline = time.Now().Add(75 * time.Second)
				case command := <-s.commands:
					if command == "stop" {
						hold = false
						s.kill()
						stopping = true
					} else {
						hold = command == "drain"
						s.drain()
						stopping = true
						drainDeadline = time.Now().Add(75 * time.Second)
					}
				case <-finished:
					settled = true
					break running
				case now := <-ticker.C:
					s.mu.Lock()
					last := s.heartbeat
					s.mu.Unlock()
					if !drainDeadline.IsZero() && now.After(drainDeadline) {
						s.kill()
					}
					if now.Sub(last) > 10*time.Second {
						s.kill()
						reason = "watchdog"
						if !stopping {
							break running
						}
					}
				}
			}
		}
		ticker.Stop()
		if startErr == nil && !settled {
			s.kill()
			<-finished
		}
		s.mu.Lock()
		s.worker = nil
		s.input = nil
		s.status = nil
		s.adminPort = 0
		s.adminSocket = ""
		s.state = "backoff"
		stopping = stopping || s.draining
		s.mu.Unlock()
		if stopping {
			if hold {
				s.waitDrained(signals)
			}
			return
		}
		failures++
		s.mu.Lock()
		s.ledger.Restarts++
		s.ledger.LastRestartAt = time.Now().UnixMilli()
		if len(s.currentFailure) == 64 {
			s.ledger.LastFailure = s.currentFailure
		} else {
			digest := sha256.Sum256([]byte("latch-relay-fatal-v1\x00" + reason))
			s.ledger.LastFailure = hex.EncodeToString(digest[:])
		}

		snapshot := s.ledger
		count := s.ledger.Restarts
		s.mu.Unlock()
		err = s.persist(snapshot)
		if err != nil {
			os.Exit(1)
		}
		delay := time.Second * time.Duration(1<<min(failures-1, 10))
		if delay > 15*time.Minute {
			delay = 15 * time.Minute
		}
		s.emit(map[string]any{"alert": "relay-restarting", "priority": "P2", "restarts": count, "retryAfterMs": delay.Milliseconds()})
		timer := time.NewTimer(delay)
		select {
		case <-timer.C:
		case <-signals:
			timer.Stop()
			return
		case command := <-s.commands:
			timer.Stop()
			if command == "drain" {
				s.drain()
				s.waitDrained(signals)
			}
			return
		}
	}
}
