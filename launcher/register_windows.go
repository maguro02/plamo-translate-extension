package main

import (
	"os"
	"os/exec"
	"path/filepath"
)

// HKCU に書くので管理者権限は要らない。値はネイティブホストの設定ファイルのパス
var registryKeys = []struct{ browser, key string }{
	{"Chrome", `HKCU\Software\Google\Chrome\NativeMessagingHosts\` + hostName},
	{"Edge", `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\` + hostName},
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
	manifestPath := filepath.Join(base, "native-host.json")
	if err := os.WriteFile(manifestPath, manifest, 0o644); err != nil {
		return nil, err
	}
	var done []string
	for _, r := range registryKeys {
		if err := exec.Command("reg", "add", r.key, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f").Run(); err == nil {
			done = append(done, r.browser)
		}
	}
	return done, nil
}
