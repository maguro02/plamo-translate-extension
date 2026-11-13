package main

import (
	"syscall"
	"unsafe"
)

// 既定のコードページ（932 など）のままだと日本語の表示が文字化けするので、UTF-8 に切り替える
func setupConsole() {
	kernel32 := syscall.NewLazyDLL("kernel32.dll")
	_, _, _ = kernel32.NewProc("SetConsoleOutputCP").Call(65001)
	if title, err := syscall.UTF16PtrFromString("PLaMo 翻訳サーバー"); err == nil {
		_, _, _ = kernel32.NewProc("SetConsoleTitleW").Call(uintptr(unsafe.Pointer(title)))
	}
}
