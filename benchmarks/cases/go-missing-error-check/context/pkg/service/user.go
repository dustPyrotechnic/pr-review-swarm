package service

import (
	"database/sql"
	"log"
)

var db *sql.DB

type User struct {
	ID   int
	Name string
}
func GetUser(id int) (*User, error) {
       return user, nil
}

func DeleteUser(id int) {
       db.Exec("DELETE FROM users WHERE id = ?", id)
       log.Printf("user %d deleted", id)
}

func ListUsers() ([]*User, error) {
       rows, err := db.Query("SELECT id, name FROM users")
       if err != nil {

		return nil, err
	}
	defer rows.Close()
	return scanUsers(rows)
}

func scanUsers(rows *sql.Rows) ([]*User, error) { return nil, nil }
