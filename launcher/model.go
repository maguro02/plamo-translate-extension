package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

const (
	hfBase    = "https://huggingface.co"
	modelRepo = "pfnet/plamo-3-translate-2b-GGUF"
	modelFile = "plamo-3-translate-2b-Q4_K_M.gguf"
)

// Hugging Face は古い版のファイルを消すことがあるため、版は固定せず起動のたびに最新の版を調べる。
// 取得するときはその版に固定した URL を使い、ダウンロード中の更新でファイルが混ざらないようにする
type modelInfo struct {
	Revision string `json:"revision"`
	SHA256   string `json:"sha256"`
	Size     int64  `json:"size"`
}

func (m modelInfo) url() string {
	return hfBase + "/" + modelRepo + "/resolve/" + m.Revision + "/" + modelFile
}

func latestModel() (modelInfo, error) {
	client := &http.Client{Timeout: 15 * time.Second}
	var rev struct {
		SHA string `json:"sha"`
	}
	if err := getJSON(client, hfBase+"/api/models/"+modelRepo+"/revision/main", &rev); err != nil {
		return modelInfo{}, err
	}
	var tree []struct {
		Path string `json:"path"`
		LFS  *struct {
			OID  string `json:"oid"`
			Size int64  `json:"size"`
		} `json:"lfs"`
	}
	if err := getJSON(client, hfBase+"/api/models/"+modelRepo+"/tree/"+rev.SHA, &tree); err != nil {
		return modelInfo{}, err
	}
	for _, f := range tree {
		if f.Path == modelFile && f.LFS != nil && rev.SHA != "" {
			return modelInfo{Revision: rev.SHA, SHA256: f.LFS.OID, Size: f.LFS.Size}, nil
		}
	}
	return modelInfo{}, fmt.Errorf("%s に %s が見つかりません", modelRepo, modelFile)
}

func getJSON(client *http.Client, url string, v any) error {
	res, err := client.Get(url)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d（%s）", res.StatusCode, url)
	}
	return json.NewDecoder(res.Body).Decode(v)
}

type modelStore struct {
	dir string
}

func (s modelStore) path() string     { return filepath.Join(s.dir, modelFile) }
func (s modelStore) infoPath() string { return filepath.Join(s.dir, "model.json") }
func (s modelStore) partPath() string { return s.path() + ".part" }
func (s modelStore) oldPath() string  { return s.path() + ".old" }

func (s modelStore) exists() bool {
	_, err := os.Stat(s.path())
	return err == nil
}

// 使っているモデルの版を返す。版の記録がなければ（以前の配布物で取得したモデル）中身から SHA-256 を計算して記録する
func (s modelStore) current(notice func(string)) (modelInfo, bool) {
	fi, err := os.Stat(s.path())
	if err != nil {
		return modelInfo{}, false
	}
	var info modelInfo
	if b, err := os.ReadFile(s.infoPath()); err == nil && json.Unmarshal(b, &info) == nil && info.Size == fi.Size() {
		return info, true
	}
	notice("翻訳モデルの版を確認しています…")
	sum, err := fileSHA256(s.path())
	if err != nil {
		return modelInfo{}, false
	}
	info = modelInfo{SHA256: sum, Size: fi.Size()}
	_ = s.save(info)
	return info, true
}

func (s modelStore) save(info modelInfo) error {
	b, err := json.MarshalIndent(info, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.infoPath(), b, 0o644)
}

// 翻訳モデルがなければ最新の版を取得する
func (s modelStore) ensure(progress func(done, total int64), notice func(string)) (modelInfo, error) {
	if info, ok := s.current(notice); ok {
		return info, nil
	}
	latest, err := latestModel()
	if err != nil {
		return modelInfo{}, fmt.Errorf("翻訳モデルの情報を取得できませんでした（%v）。インターネット接続を確認して、もう一度起動してください", err)
	}
	notice(fmt.Sprintf("初回のみ、翻訳モデル（約%.1fGB）をダウンロードします。", float64(latest.Size)/1e9))
	if err := s.fetch(latest, progress, notice); err != nil {
		return modelInfo{}, err
	}
	if err := os.Rename(s.partPath(), s.path()); err != nil {
		return modelInfo{}, err
	}
	return latest, s.save(latest)
}

// 指定した版を .part に取得して照合する。差し替えは swapIn で行う
func (s modelStore) fetch(info modelInfo, progress func(done, total int64), notice func(string)) error {
	if err := os.MkdirAll(s.dir, 0o755); err != nil {
		return err
	}
	for attempt := 1; ; attempt++ {
		err := s.download(info, progress)
		if err == nil {
			break
		}
		if attempt >= 3 {
			return fmt.Errorf("翻訳モデルをダウンロードできませんでした（%v）。インターネット接続を確認して、もう一度起動してください", err)
		}
		notice(fmt.Sprintf("ダウンロードが中断されました（%v）。続きから再開します…", err))
		time.Sleep(3 * time.Second)
	}
	notice("ダウンロードしたファイルを確認しています…")
	sum, err := fileSHA256(s.partPath())
	if err != nil {
		return err
	}
	if sum != info.SHA256 {
		_ = os.Remove(s.partPath())
		_ = os.Remove(s.partPath() + ".json")
		return errors.New("ダウンロードした翻訳モデルが壊れています。もう一度起動してダウンロードし直してください")
	}
	_ = os.Remove(s.partPath() + ".json")
	return nil
}

// 途中まで保存したファイルが同じ版のものなら Range 指定で続きから取得する
func (s modelStore) download(info modelInfo, progress func(done, total int64)) error {
	part := s.partPath()
	partInfo := part + ".json"
	var offset int64
	var prev modelInfo
	if b, err := os.ReadFile(partInfo); err == nil && json.Unmarshal(b, &prev) == nil && prev.SHA256 == info.SHA256 {
		if fi, err := os.Stat(part); err == nil {
			offset = fi.Size()
		}
	}
	if offset == info.Size {
		return nil
	}
	if b, err := json.Marshal(info); err == nil {
		_ = os.WriteFile(partInfo, b, 0o644)
	}
	req, err := http.NewRequest(http.MethodGet, info.url(), nil)
	if err != nil {
		return err
	}
	if offset > 0 {
		req.Header.Set("Range", "bytes="+strconv.FormatInt(offset, 10)+"-")
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	flags := os.O_CREATE | os.O_WRONLY
	switch res.StatusCode {
	case http.StatusPartialContent:
		flags |= os.O_APPEND
	case http.StatusOK:
		offset = 0
		flags |= os.O_TRUNC
	default:
		return fmt.Errorf("HTTP %d", res.StatusCode)
	}
	f, err := os.OpenFile(part, flags, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()

	written := offset
	buf := make([]byte, 1<<20)
	for {
		n, rerr := res.Body.Read(buf)
		if n > 0 {
			if _, werr := f.Write(buf[:n]); werr != nil {
				return werr
			}
			written += int64(n)
			progress(written, info.Size)
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return rerr
		}
	}
	if written != info.Size {
		return fmt.Errorf("サイズが一致しません（%d / %d バイト）", written, info.Size)
	}
	return f.Sync()
}

// 取得済みの新しい版に差し替える。新しい版で起動できなかったときのために、戻す関数を返す
func (s modelStore) swapIn(info modelInfo) (rollback func() error, err error) {
	prev, hadPrev := modelInfo{}, false
	if b, err := os.ReadFile(s.infoPath()); err == nil && json.Unmarshal(b, &prev) == nil {
		hadPrev = true
	}
	_ = os.Remove(s.oldPath())
	if err := os.Rename(s.path(), s.oldPath()); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if err := os.Rename(s.partPath(), s.path()); err != nil {
		_ = os.Rename(s.oldPath(), s.path())
		return nil, err
	}
	if err := s.save(info); err != nil {
		return nil, err
	}
	return func() error {
		if err := os.Rename(s.oldPath(), s.path()); err != nil {
			return err
		}
		if hadPrev {
			return s.save(prev)
		}
		return os.Remove(s.infoPath())
	}, nil
}

// 新しい版で起動できたら、残しておいた古い版を消す
func (s modelStore) commit() {
	_ = os.Remove(s.oldPath())
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
