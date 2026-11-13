package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"sync"
	"syscall"
	"time"
)

// Chrome のネイティブメッセージング: 4 バイトのメッセージ長（ネイティブのバイト順）に続けて UTF-8 の JSON
const maxMessageSize = 1 << 20

type host struct {
	base      string
	store     modelStore
	healthURL string
	log       *log.Logger

	// 最新の版はホストの起動時に 1 回だけ調べる（status のたびに Hugging Face へ問い合わせない）
	latestMu sync.Mutex
	latest   *modelInfo
	current  *modelInfo

	outMu sync.Mutex

	mu         sync.Mutex
	srv        *server
	starting   bool
	stopWanted bool
}

func runNativeHost() {
	base, err := baseDir()
	if err != nil {
		os.Exit(1)
	}
	_ = os.MkdirAll(filepath.Join(base, "logs"), 0o755)
	logOut := io.Discard
	if f, err := os.OpenFile(filepath.Join(base, "logs", "native-host.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644); err == nil {
		defer f.Close()
		logOut = f
	}
	h := &host{
		base:      base,
		store:     modelStore{dir: filepath.Join(base, "models")},
		healthURL: fmt.Sprintf("http://127.0.0.1:%d/health", defaultPort),
		log:       log.New(logOut, "", log.LstdFlags),
	}
	if runtime.GOOS == "darwin" {
		_ = exec.Command("xattr", "-dr", "com.apple.quarantine", base).Run()
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sig
		h.shutdown()
		os.Exit(0)
	}()
	go h.checkLatest()

	in := bufio.NewReader(os.Stdin)
	for {
		var msg struct {
			Type string `json:"type"`
		}
		if err := readMessage(in, &msg); err != nil {
			if !errors.Is(err, io.EOF) {
				h.log.Println("read:", err)
			}
			break
		}
		switch msg.Type {
		case "status":
			h.sendStatus()
		case "start":
			go h.start()
		case "stop":
			h.stopServer()
			h.sendStatus()
		case "update":
			go h.update()
		}
	}
	// Chrome がポートを閉じた（拡張が切断した、Chrome を終了した）ので、起動した翻訳サーバーも止める
	h.shutdown()
}

func readMessage(r io.Reader, v any) error {
	var size uint32
	if err := binary.Read(r, binary.LittleEndian, &size); err != nil {
		return err
	}
	if size > maxMessageSize {
		return fmt.Errorf("message too large: %d", size)
	}
	buf := make([]byte, size)
	if _, err := io.ReadFull(r, buf); err != nil {
		return err
	}
	return json.Unmarshal(buf, v)
}

func (h *host) send(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	h.outMu.Lock()
	defer h.outMu.Unlock()
	_ = binary.Write(os.Stdout, binary.LittleEndian, uint32(len(b)))
	_, _ = os.Stdout.Write(b)
}

func (h *host) sendStatus() {
	h.mu.Lock()
	managed := h.srv != nil
	variant := ""
	if h.srv != nil {
		variant = label(h.srv.variant)
	}
	starting := h.starting
	h.mu.Unlock()
	h.send(map[string]any{
		"type":            "status",
		"running":         healthy(h.healthURL),
		"managed":         managed,
		"starting":        starting,
		"variant":         variant,
		"modelReady":      h.store.exists(),
		"updateAvailable": h.updateAvailable(),
	})
}

func (h *host) sendError(err error) {
	h.log.Println("error:", err)
	h.send(map[string]any{"type": "error", "message": err.Error()})
}

func (h *host) start() {
	h.mu.Lock()
	if h.starting || h.srv != nil {
		h.mu.Unlock()
		h.sendStatus()
		return
	}
	h.starting = true
	h.stopWanted = false
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		h.starting = false
		h.mu.Unlock()
		h.sendStatus()
	}()

	// コンソールから起動したサーバーなど、すでに応答があるものはそのまま使う
	if healthy(h.healthURL) {
		return
	}
	h.sendStatus()

	current, err := h.store.ensure(h.progress(), h.notice)
	if err != nil {
		h.sendError(err)
		return
	}
	h.setCurrent(current)

	srv, err := startBest(h.base, h.store.path(), defaultPort, true, h.notice)
	if err != nil {
		h.sendError(err)
		return
	}
	h.adopt(srv)
}

func (h *host) progress() func(done, total int64) {
	last := time.Time{}
	return func(done, total int64) {
		if time.Since(last) > 250*time.Millisecond || done == total {
			last = time.Now()
			h.send(map[string]any{"type": "progress", "loaded": done, "total": total})
		}
	}
}

func (h *host) notice(msg string) {
	h.log.Println(msg)
	h.send(map[string]any{"type": "notice", "message": msg})
}

// 起動したサーバーを管理下に置き、終了したら拡張に知らせる
func (h *host) adopt(srv *server) {
	h.mu.Lock()
	if h.stopWanted {
		h.mu.Unlock()
		srv.stop()
		return
	}
	h.srv = srv
	h.mu.Unlock()
	h.log.Println("started:", srv.variant)
	h.send(map[string]any{"type": "started", "variant": label(srv.variant)})

	go func() {
		<-srv.done
		h.mu.Lock()
		stillOurs := h.srv == srv
		if stillOurs {
			h.srv = nil
		}
		h.mu.Unlock()
		if stillOurs {
			h.log.Println("server exited:", srv.err)
			h.send(map[string]any{"type": "exited"})
		}
	}()
}

func (h *host) checkLatest() {
	latest, err := latestModel()
	if err != nil {
		h.log.Println("latest:", err)
		return
	}
	h.latestMu.Lock()
	h.latest = &latest
	h.latestMu.Unlock()
}

func (h *host) setCurrent(info modelInfo) {
	h.latestMu.Lock()
	h.current = &info
	h.latestMu.Unlock()
}

func (h *host) updateAvailable() bool {
	h.latestMu.Lock()
	defer h.latestMu.Unlock()
	if h.latest == nil {
		return false
	}
	if h.current == nil {
		if !h.store.exists() {
			return false
		}
		if info, ok := h.store.current(func(string) {}); ok {
			h.current = &info
		} else {
			return false
		}
	}
	return h.latest.SHA256 != h.current.SHA256
}

// 新しい版を取得し、サーバーを止めて差し替え、起動を確かめる。起動できなければ元の版に戻す。
// 更新前に止まっていたサーバーは、確認のあと再び止める
func (h *host) update() {
	h.mu.Lock()
	if h.starting {
		h.mu.Unlock()
		h.sendStatus()
		return
	}
	h.starting = true
	h.stopWanted = false
	wasRunning := h.srv != nil
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		h.starting = false
		h.mu.Unlock()
		h.sendStatus()
	}()
	h.sendStatus()

	latest, err := latestModel()
	if err != nil {
		h.sendError(fmt.Errorf("翻訳モデルの情報を取得できませんでした（%v）", err))
		return
	}
	h.notice(fmt.Sprintf("翻訳モデルの新しい版（約%.1fGB）をダウンロードしています…", float64(latest.Size)/1e9))
	if err := h.store.fetch(latest, h.progress(), h.notice); err != nil {
		h.sendError(err)
		return
	}
	// Windows は使用中のファイルを置き換えられないので、差し替える前にサーバーを止める
	h.stopServer()
	h.mu.Lock()
	h.stopWanted = false
	h.mu.Unlock()
	rollback, err := h.store.swapIn(latest)
	if err != nil {
		h.sendError(err)
		return
	}
	srv, err := startBest(h.base, h.store.path(), defaultPort, true, h.notice)
	if err != nil {
		h.notice("新しい版では起動できなかったため、元の版に戻しました。")
		if rerr := rollback(); rerr != nil {
			h.sendError(fmt.Errorf("元の版に戻せませんでした（%v）", rerr))
			return
		}
		if wasRunning {
			if srv, err = startBest(h.base, h.store.path(), defaultPort, true, h.notice); err == nil {
				h.adopt(srv)
			}
		}
		h.sendError(errors.New("新しい版の翻訳モデルでは起動できませんでした。元の版を使い続けます"))
		return
	}
	h.store.commit()
	h.setCurrent(latest)
	h.latestMu.Lock()
	h.latest = &latest
	h.latestMu.Unlock()
	h.notice("翻訳モデルを新しい版に更新しました。")
	if wasRunning {
		h.adopt(srv)
	} else {
		srv.stop()
	}
}

func (h *host) stopServer() {
	h.mu.Lock()
	srv := h.srv
	h.srv = nil
	if h.starting {
		h.stopWanted = true
	}
	h.mu.Unlock()
	if srv != nil {
		srv.stop()
		h.log.Println("stopped")
	}
}

func (h *host) shutdown() {
	h.stopServer()
}

func hostManifest(exe string) ([]byte, error) {
	if extensionID == "" {
		return nil, errors.New("拡張の ID が埋め込まれていません")
	}
	return json.MarshalIndent(map[string]any{
		"name":            hostName,
		"description":     "PLaMo 翻訳サーバー",
		"path":            exe,
		"type":            "stdio",
		"allowed_origins": []string{"chrome-extension://" + extensionID + "/"},
	}, "", "  ")
}

func executablePath() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(exe)
}
