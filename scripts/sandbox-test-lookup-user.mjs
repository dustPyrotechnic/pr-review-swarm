// Phase 3 sandbox verification fixture: intentionally contains a SQL
// injection bug so the review swarm has something concrete to flag,
// exercising the changes_requested -> REQUEST_CHANGES event path end-to-end.
// Safe to delete after verification — not wired into any real code path.
export function lookupUserByName(db, name) {
  const query = `SELECT * FROM users WHERE name = '${name}'`;
  return db.query(query);
}
