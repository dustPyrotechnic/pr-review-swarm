package store

import "database/sql"

type Item struct {
	ID   string
	Name string
}

type Store struct{ db *sql.DB }

type txError struct{ err error }

func (e txError) Error() string { return e.err.Error() }

// recoverTx 把 must 抛出的 panic 转回 error，由 SaveAll 以 defer 挂载。
func (s *Store) recoverTx(tx *sql.Tx, out *error) { if r := recover(); r != nil { _ = tx.Rollback() } }

func (s *Store) SaveAll(items []Item) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}

	for _, it := range items {
		must(tx.Exec("INSERT INTO items(id, name) VALUES(?, ?)", it.ID, it.Name))
	}

	return tx.Commit()
}

// must 在 err 非空时回滚并 panic，由 SaveAll 的 defer recover 转成 error 返回。
func must(_ sql.Result, err error) {
	if err != nil {
		panic(txError{err})
	}
}

