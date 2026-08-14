package handler

import (
	"net/http"
	"os"
	"path/filepath"
)

// uploadDir 下存放用户上传的文件；文件名由客户端提供。
const uploadDir = "/var/lib/app/uploads"

func RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/download", DownloadHandler)
	mux.HandleFunc("/upload", UploadHandler)
}

func UploadHandler(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusCreated)
}

func DownloadHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", 405)
		return
	}

	name := r.URL.Query().Get("file")
	data, err := os.ReadFile(filepath.Join(uploadDir, name))
	if err != nil {
		http.Error(w, "not found", 404)
		return
	}
	w.Write(data)
}

