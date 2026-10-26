//go:build !windows

// A single connection's platform TLS boundary. Config and both streams arrive on
// private inherited descriptors; the Host root key never enters this process.
package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"runtime"
	"time"
)

type configuration struct {
	Certificate string   `json:"certificate"`
	Key         string   `json:"key"`
	Authorities []string `json:"authorities"`
	PeerSPKI    string   `json:"peerSpki"`
	Pairing     bool     `json:"pairing"`
}

func descriptor(number uintptr) (net.Conn, error) {
	file := os.NewFile(number, "latch-private-stream")
	if file == nil {
		return nil, errors.New("descriptor")
	}
	defer file.Close()
	return net.FileConn(file)
}

func serve() error {
	decoder := json.NewDecoder(io.LimitReader(os.Stdin, 16385))
	decoder.DisallowUnknownFields()
	var input configuration
	if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF || len(input.Certificate) > 8192 || len(input.Key) > 4096 || len(input.Authorities) > 2 {
		return errors.New("configuration")
	}
	certificate, err := tls.X509KeyPair([]byte(input.Certificate), []byte(input.Key))
	if err != nil {
		return errors.New("certificate")
	}
	peerSPKI, err := base64.RawURLEncoding.DecodeString(input.PeerSPKI)
	if !input.Pairing && (err != nil || len(peerSPKI) > 256 || len(peerSPKI) == 0 || len(input.Authorities) == 0) {
		return errors.New("identity")
	}
	if input.Pairing && (input.PeerSPKI != "" || len(input.Authorities) != 0) {
		return errors.New("identity")
	}
	options := &tls.Config{
		Certificates: []tls.Certificate{certificate}, MinVersion: tls.VersionTLS13, MaxVersion: tls.VersionTLS13,
		NextProtos: []string{"h2"}, SessionTicketsDisabled: true,
		GetConfigForClient: func(hello *tls.ClientHelloInfo) (*tls.Config, error) {
			if hello.ServerName != "transport.latch.invalid" {
				return nil, errors.New("name")
			}
			return nil, nil
		},
	}
	if !input.Pairing {
		pool := x509.NewCertPool()
		for _, pem := range input.Authorities {
			if len(pem) > 8192 || !pool.AppendCertsFromPEM([]byte(pem)) {
				return errors.New("authority")
			}
		}
		options.ClientCAs = pool
		options.ClientAuth = tls.RequireAndVerifyClientCert
	}
	options.VerifyConnection = func(state tls.ConnectionState) error {
		if state.Version != tls.VersionTLS13 || state.NegotiatedProtocol != "h2" || state.ServerName != "transport.latch.invalid" || state.DidResume {
			return errors.New("protocol")
		}
		if input.Pairing {
			if len(state.PeerCertificates) != 0 {
				return errors.New("pairing")
			}
			return nil
		}
		if len(state.PeerCertificates) == 0 || len(state.PeerCertificates) > 4 || len(state.VerifiedChains) == 0 {
			return errors.New("chain")
		}
		leaf := state.PeerCertificates[0]
		name := leaf.Subject.String()
		if !bytes.Equal(leaf.RawSubjectPublicKeyInfo, peerSPKI) || (name != "CN=transport.latch.invalid" && name != "CN=connection.latch.invalid") || leaf.Issuer.String() != "CN=transport.latch.invalid" || time.Now().Before(leaf.NotBefore) || !time.Now().Before(leaf.NotAfter) || leaf.CheckSignature(leaf.SignatureAlgorithm, leaf.RawTBSCertificate, leaf.Signature) != nil {
			return errors.New("peer")
		}
		return nil
	}
	ciphertext, err := descriptor(3)
	if err != nil {
		return err
	}
	defer ciphertext.Close()
	application, err := descriptor(4)
	if err != nil {
		return err
	}
	defer application.Close()
	secure := tls.Server(ciphertext, options)
	deadline, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = ciphertext.SetDeadline(time.Now().Add(3 * time.Second))
	if secure.HandshakeContext(deadline) != nil {
		return errors.New("handshake")
	}
	_ = ciphertext.SetDeadline(time.Time{})
	if json.NewEncoder(os.Stdout).Encode(map[string]any{"protocol": 1, "ready": true}) != nil {
		return errors.New("ready")
	}
	settled := make(chan struct{}, 2)
	go func() { _, _ = io.CopyBuffer(application, secure, make([]byte, 32768)); settled <- struct{}{} }()
	go func() { _, _ = io.CopyBuffer(secure, application, make([]byte, 32768)); settled <- struct{}{} }()
	<-settled
	_ = ciphertext.Close()
	_ = application.Close()
	<-settled
	return nil
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "version" {
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"protocol": 1, "go": runtime.Version()})
		return
	}
	if len(os.Args) != 1 || serve() != nil {
		os.Exit(1)
	}
}
