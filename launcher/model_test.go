package main

import (
	"os"
	"path/filepath"
	"testing"
)

func writeModel(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestCurrentRecordsHashOfUnrecordedModel(t *testing.T) {
	s := modelStore{dir: t.TempDir()}
	writeModel(t, s.path(), "old")
	info, ok := s.current(func(string) {})
	if !ok || info.SHA256 == "" || info.Size != 3 {
		t.Fatalf("current() = %+v, %v", info, ok)
	}
	if _, err := os.Stat(s.infoPath()); err != nil {
		t.Fatal("model.json was not written")
	}
}

func TestSwapInThenRollbackRestoresOldModel(t *testing.T) {
	s := modelStore{dir: t.TempDir()}
	writeModel(t, s.path(), "old")
	oldInfo := modelInfo{Revision: "r1", SHA256: "aaa", Size: 3}
	if err := s.save(oldInfo); err != nil {
		t.Fatal(err)
	}
	writeModel(t, s.partPath(), "new!")
	rollback, err := s.swapIn(modelInfo{Revision: "r2", SHA256: "bbb", Size: 4})
	if err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, s.path()); got != "new!" {
		t.Fatalf("after swapIn: %q", got)
	}
	if err := rollback(); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, s.path()); got != "old" {
		t.Fatalf("after rollback: %q", got)
	}
	if info, ok := s.current(func(string) {}); !ok || info != oldInfo {
		t.Fatalf("after rollback info = %+v", info)
	}
}

func TestSwapInThenCommitRemovesOldModel(t *testing.T) {
	s := modelStore{dir: t.TempDir()}
	writeModel(t, s.path(), "old")
	writeModel(t, s.partPath(), "new!")
	if _, err := s.swapIn(modelInfo{Revision: "r2", SHA256: "bbb", Size: 4}); err != nil {
		t.Fatal(err)
	}
	s.commit()
	if _, err := os.Stat(s.oldPath()); !os.IsNotExist(err) {
		t.Fatal(".old should be removed")
	}
	entries, _ := os.ReadDir(filepath.Dir(s.path()))
	if len(entries) != 2 {
		t.Fatalf("unexpected files: %v", entries)
	}
}

func TestLatestModelFromHuggingFace(t *testing.T) {
	if testing.Short() {
		t.Skip("network")
	}
	info, err := latestModel()
	if err != nil {
		t.Fatal(err)
	}
	if len(info.Revision) != 40 || len(info.SHA256) != 64 || info.Size < 1e9 {
		t.Fatalf("unexpected: %+v", info)
	}
	t.Logf("latest: %+v", info)
}
