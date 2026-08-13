package store

import (
	"database/sql"
	"errors"
)

var ErrEmptyKeyword = errors.New("keyword must not be empty")

type Article struct {
	ID    int
	Title string
}

type Store struct{ db *sql.DB }

func (s *Store) Search(keyword string) ([]Article, error) {
	if keyword == "" {
		return nil, ErrEmptyKeyword
	}

	query := "SELECT id, title FROM articles WHERE title LIKE '%" + keyword + "%'"
	rows, err := s.db.Query(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	return scanArticles(rows)
}


func scanArticles(rows *sql.Rows) ([]Article, error) {
	var out []Article
	for rows.Next() {
		var a Article
		if err := rows.Scan(&a.ID, &a.Title); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}
