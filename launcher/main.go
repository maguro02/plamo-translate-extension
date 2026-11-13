// PLaMo 翻訳サーバーの起動プログラム。
// ダブルクリックで実行すると、Chrome 拡張から呼び出せるよう自分を登録し、翻訳サーバーを起動する。
// Chrome から呼び出されたとき（引数に chrome-extension:// が付く）はネイティブホストとして動く。
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	hostName       = "jp.plamo_translate.server"
	defaultPort    = 8802
	startTimeout   = 3 * time.Minute
	updateQuestion = 15 * time.Second
)

// ビルド時に -ldflags "-X main.extensionID=..." で埋め込む。ネイティブホストを呼び出してよい拡張の ID
var extensionID = ""

// Windows は GPU（Vulkan）版を先に試し、起動できなければ CPU 版に切り替える
var variants = map[string][]string{
	"windows": {"llama-vulkan", "llama-cpu"},
	"darwin":  {"llama-metal"},
}

func main() {
	if origin := nativeOrigin(os.Args[1:]); origin != "" {
		runNativeHost()
		return
	}
	port := flag.Int("port", defaultPort, "待ち受けるポート番号")
	flag.Parse()
	setupConsole()

	if err := runConsole(*port); err != nil {
		fmt.Println()
		fmt.Println("エラー:", err)
		waitEnter()
		os.Exit(1)
	}
}

func nativeOrigin(args []string) string {
	for _, a := range args {
		if strings.HasPrefix(a, "chrome-extension://") {
			return a
		}
	}
	return ""
}

func runConsole(port int) error {
	base, err := baseDir()
	if err != nil {
		return err
	}
	fmt.Println("PLaMo 翻訳サーバー")
	fmt.Println("------------------")

	if runtime.GOOS == "darwin" {
		// zip から展開したファイルには隔離属性が付き、同梱の llama-server の実行が止められるので外す
		_ = exec.Command("xattr", "-dr", "com.apple.quarantine", base).Run()
	}
	if browsers, err := registerNativeHost(base); err != nil {
		fmt.Println("Chrome 拡張から起動できるようにする登録に失敗しました:", err)
	} else if len(browsers) > 0 {
		fmt.Printf("Chrome 拡張から起動・停止できるように登録しました（%s）。\n", strings.Join(browsers, "・"))
	}

	healthURL := fmt.Sprintf("http://127.0.0.1:%d/health", port)
	if healthy(healthURL) {
		fmt.Printf("すでに起動しています（127.0.0.1:%d）。このウインドウは閉じて構いません。\n", port)
		waitEnter()
		return nil
	}

	store := modelStore{dir: filepath.Join(base, "models")}
	last := time.Time{}
	progress := func(done, total int64) {
		if time.Since(last) > 300*time.Millisecond || done == total {
			last = time.Now()
			fmt.Printf("\r  %3d%%  %.2f / %.2f GB", done*100/total, float64(done)/1e9, float64(total)/1e9)
		}
	}
	notice := func(msg string) { fmt.Println("\n" + msg) }
	current, err := store.ensure(progress, notice)
	if err != nil {
		return err
	}

	var rollback func() error
	if latest, err := latestModel(); err == nil && latest.SHA256 != current.SHA256 {
		fmt.Printf("\n翻訳モデルの新しい版があります（約%.1fGB）。\n", float64(latest.Size)/1e9)
		if askYes(fmt.Sprintf("今ダウンロードして更新しますか？ [y/N]（%d 秒たつと「いいえ」で続けます）: ", int(updateQuestion.Seconds())), updateQuestion) {
			if err := store.fetch(latest, progress, notice); err != nil {
				fmt.Println("\n更新できなかったため、今の版で起動します:", err)
			} else if rollback, err = store.swapIn(latest); err != nil {
				fmt.Println("\n更新できなかったため、今の版で起動します:", err)
				rollback = nil
			}
		}
	}

	srv, err := startBest(base, store.path(), port, false, func(msg string) { fmt.Println(msg) })
	if rollback != nil {
		if err != nil {
			fmt.Println("新しい版では起動できなかったため、元の版に戻して起動し直します。")
			if rerr := rollback(); rerr != nil {
				return fmt.Errorf("元の版に戻せませんでした（%v）", rerr)
			}
			srv, err = startBest(base, store.path(), port, false, func(msg string) { fmt.Println(msg) })
		} else {
			store.commit()
		}
	}
	if err != nil {
		return err
	}
	fmt.Println()
	fmt.Printf("起動しました: http://127.0.0.1:%d（%s）\n", port, label(srv.variant))
	fmt.Println("Chrome 拡張の翻訳がこのサーバーを使います。")
	fmt.Println("止めるときは、このウインドウを閉じるか Ctrl+C を押してください。")

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	select {
	case <-sig:
		fmt.Println("\n停止しています…")
		srv.stop()
		return nil
	case <-srv.done:
		if srv.err != nil {
			return fmt.Errorf("翻訳サーバーが終了しました（%v）", srv.err)
		}
		return errors.New("翻訳サーバーが終了しました")
	}
}

func label(variant string) string {
	switch variant {
	case "llama-vulkan":
		return "GPU（Vulkan）"
	case "llama-metal":
		return "GPU（Metal）"
	default:
		return "CPU"
	}
}

func baseDir() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		return "", err
	}
	return filepath.Dir(exe), nil
}

func healthy(url string) bool {
	client := http.Client{Timeout: 2 * time.Second}
	res, err := client.Get(url)
	if err != nil {
		return false
	}
	res.Body.Close()
	return res.StatusCode == http.StatusOK
}

type server struct {
	cmd     *exec.Cmd
	done    chan struct{}
	err     error
	variant string
}

func (s *server) stop() {
	_ = s.cmd.Process.Kill()
	<-s.done
}

// 同梱の llama-server を順に試し、/health が応答した最初のものを返す
func startBest(base, modelPath string, port int, background bool, notice func(string)) (*server, error) {
	names := variants[runtime.GOOS]
	if names == nil {
		return nil, fmt.Errorf("この OS（%s）には対応していません", runtime.GOOS)
	}
	logDir := filepath.Join(base, "logs")
	if err := os.MkdirAll(logDir, 0o755); err != nil {
		return nil, err
	}
	logPath := filepath.Join(logDir, "server.log")
	healthURL := fmt.Sprintf("http://127.0.0.1:%d/health", port)
	for i, name := range names {
		srv, err := startServer(base, name, modelPath, port, logPath, background)
		if err != nil {
			notice(fmt.Sprintf("%s を起動できませんでした: %v", label(name), err))
			continue
		}
		notice(fmt.Sprintf("翻訳モデルを読み込んでいます（%s）…", label(name)))
		if waitReady(healthURL, srv.done) {
			return srv, nil
		}
		srv.stop()
		if i+1 < len(names) {
			notice(fmt.Sprintf("%s では起動できなかったため、%s で起動し直します。", label(name), label(names[i+1])))
		}
	}
	return nil, fmt.Errorf("翻訳サーバーを起動できませんでした。詳しくは %s を確認してください", logPath)
}

func startServer(base, variant, modelPath string, port int, logPath string, background bool) (*server, error) {
	name := "llama-server"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	bin := filepath.Join(base, variant, name)
	if _, err := os.Stat(bin); err != nil {
		return nil, err
	}
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return nil, err
	}
	// 4 並列 × 各 4096 トークン。拡張は段落単位で送るので 1 件あたりの長さはこれで足りる
	cmd := exec.Command(bin,
		"-m", modelPath,
		"--host", "127.0.0.1",
		"--port", strconv.Itoa(port),
		"-c", "16384",
		"-np", "4",
		"--alias", "plamo-3-translate-2b",
		"--no-webui",
		"-lv", "2",
	)
	cmd.Dir = filepath.Join(base, variant)
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	if background {
		hideWindow(cmd)
	}
	if err := cmd.Start(); err != nil {
		logFile.Close()
		return nil, err
	}
	// 起動プログラムが強制終了されても llama-server が残らないようにする（Windows のみ）
	bindToParent(cmd)
	srv := &server{cmd: cmd, done: make(chan struct{}), variant: variant}
	go func() {
		srv.err = cmd.Wait()
		logFile.Close()
		close(srv.done)
	}()
	return srv, nil
}

func waitReady(url string, done chan struct{}) bool {
	ctx, cancel := context.WithTimeout(context.Background(), startTimeout)
	defer cancel()
	tick := time.NewTicker(500 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-done:
			return false
		case <-ctx.Done():
			return false
		case <-tick.C:
			if healthy(url) {
				return true
			}
		}
	}
}

// timeout までに入力がなければ「いいえ」とみなす（ダブルクリックで起動したまま放置しても止まらないようにする）
func askYes(prompt string, timeout time.Duration) bool {
	fmt.Print(prompt)
	answer := make(chan string, 1)
	go func() {
		line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
		answer <- strings.TrimSpace(strings.ToLower(line))
	}()
	select {
	case a := <-answer:
		return a == "y" || a == "yes"
	case <-time.After(timeout):
		fmt.Println()
		return false
	}
}

func waitEnter() {
	fmt.Println("Enter キーを押すと閉じます。")
	_, _ = bufio.NewReader(os.Stdin).ReadString('\n')
}
