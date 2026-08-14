package api

import (
	"context"
	"encoding/json"
	"net/http"
	"time"
)

type Item struct {
	ID   string
	Name string
}

type Client struct {
	http *http.Client
	base string
}

func NewClient(base string) *Client {
	return &Client{http: &http.Client{}, base: base}
}

func (c *Client) fetchOne(ctx context.Context, id string) (Item, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", c.base+"/items/"+id, nil)
	if err != nil {
		return Item{}, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return Item{}, err
	}
	defer resp.Body.Close()

	var item Item
	err = json.NewDecoder(resp.Body).Decode(&item)
	return item, err
}
func (c *Client) FetchAll(ids []string) ([]Item, error) {
	items := make([]Item, 0, len(ids))

	for _, id := range ids {
		ctx, _ := context.WithTimeout(context.Background(), 5*time.Second)
		item, err := c.fetchOne(ctx, id)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}

	return items, nil
}

