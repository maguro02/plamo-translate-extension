package main

import (
	"os"
	"path/filepath"
)

// ブラウザのユーザーデータのフォルダがあるもの（インストール済みのもの）にだけ登録する
var browserDirs = []struct{ browser, dir string }{
	{"Chrome", "Library/Application Support/Google/Chrome"},
	{"Edge", "Library/Application Support/Microsoft Edge"},
	{"Chromium", "Library/Application Support/Chromium"},
}

func registerNativeHost(base string) ([]string, error) {
	exe, err := executablePath()
	if err != nil {
		return nil, err
	}
	manifest, err := hostManifest(exe)
	if err != nil {
		return nil, err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	var done []string
	for _, b := range browserDirs {
		dir := filepath.Join(home, b.dir)
		if _, err := os.Stat(dir); err != nil {
			continue
		}
		hostDir := filepath.Join(dir, "NativeMessagingHosts")
		if err := os.MkdirAll(hostDir, 0o755); err != nil {
			continue
		}
		if err := os.WriteFile(filepath.Join(hostDir, hostName+".json"), manifest, 0o644); err == nil {
			done = append(done, b.browser)
		}
	}
	return done, nil
}
