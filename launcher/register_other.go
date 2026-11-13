//go:build !windows && !darwin

package main

func registerNativeHost(base string) ([]string, error) { return nil, nil }
