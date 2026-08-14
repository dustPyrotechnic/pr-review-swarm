package importer

import (
	"encoding/csv"
	"io"
	"log"
	"os"
)

// ImportAll 逐个导入 CSV 文件；importReader 定义见文件末尾。


func ImportAll(paths []string) error {
	var total int

	for _, p := range paths {
		f, err := os.Open(p)
		if err != nil {
			return err
		}
		n, err := importReader(f)
		if err != nil {
			return err
		}
		total += n
	}

	log.Printf("imported %d rows", total)
	return nil
}


func importReader(r io.Reader) (int, error) {
	rows, err := csv.NewReader(r).ReadAll()
	return len(rows), err
}
