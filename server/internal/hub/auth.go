package hub

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// Who is calling: a person's session (only its sha256 is stored) or a machine's own token (tam_…). How people get a
// session (invites, login codes) is in team.go.

const (
	seenEvery   = time.Hour
	sessionIdle = 30 * 24 * time.Hour
)

type principal struct {
	machine   bool
	session   string // sha256 of the session id
	userID    string // the person signed in (a session), or the machine's owner (a machine token)
	machineID string // the machine of a per-machine token
}

const machineTokenPrefix = "tam_"

func credential(r *http.Request) string {
	if a := r.Header.Get("authorization"); strings.HasPrefix(a, "Bearer ") {
		return strings.TrimSpace(a[7:])
	}
	return r.URL.Query().Get("token") // WebSocket / <img> can't send headers
}

var hex64 = regexp.MustCompile(`^[0-9a-f]{64}$`)

// who: the machine for the token, the session for an owner session, nil otherwise. A session whose email left the
// allow-list, or that went unused past sessionIdle, is deleted on sight. Call with h.mu held.
func (h *Hub) who(r *http.Request) *principal {
	t := credential(r)
	if t == "" {
		return nil
	}
	if strings.HasPrefix(t, machineTokenPrefix) {
		var mid, owner string
		var disabled bool
		err := h.db.QueryRow(`SELECT m.id, m.owner_id, u.disabled FROM machines m JOIN users u ON u.id = m.owner_id WHERE m.token_hash = ?`,
			sha256hex([]byte(t))).Scan(&mid, &owner, &disabled)
		if err != nil || disabled {
			return nil
		}
		h.must(h.db.Exec("UPDATE machines SET last_seen = ? WHERE id = ?", h.nowMs(), mid))
		return &principal{machine: true, machineID: mid, userID: owner}
	}
	if !hex64.MatchString(t) {
		return nil
	}
	id := sha256hex([]byte(t))
	var lastSeen int64
	var email, scope, userID string
	var scopeN, userN *string
	if err := h.db.QueryRow("SELECT last_seen, email, scope, user_id FROM sessions WHERE id = ?", id).Scan(&lastSeen, &email, &scopeN, &userN); err != nil {
		return nil
	}
	if scopeN != nil {
		scope = *scopeN
	}
	if userN != nil {
		userID = *userN
	}
	now := h.nowMs()
	// a person's session lives as long as the person is enabled (sessions without one were noop's single owner's)
	allowed := userID != "" && h.count("SELECT COUNT(*) FROM users WHERE id = ? AND disabled = 0", userID) == 1
	if !allowed || now-lastSeen > sessionIdle.Milliseconds() {
		h.must(h.db.Exec("DELETE FROM sessions WHERE id = ?", id))
		return nil
	}
	if scope == "mcp" { // connector tokens are for /mcp only, which this server does not serve
		return nil
	}
	if now-lastSeen > seenEvery.Milliseconds() {
		h.must(h.db.Exec("UPDATE sessions SET last_seen = ? WHERE id = ?", now, id))
	}
	return &principal{session: id, userID: userID}
}

func normEmail(e string) string { return strings.ToLower(strings.TrimSpace(e)) }

var emailRE = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)

func validEmail(e string) bool { return len(e) <= 254 && emailRE.MatchString(e) }

// ---------------------------------------------------------------- one-time codes

const codeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789" // no 0/O, 1/I/L
const codeLen = 8

var codeRE = regexp.MustCompile("^[" + codeAlphabet + "]{8}$")

func newCode() string {
	out := make([]byte, 0, codeLen)
	b := make([]byte, 1)
	for len(out) < codeLen {
		if _, err := rand.Read(b); err != nil {
			panic(err)
		}
		if b[0] < 248 { // unbiased: 248 = 8 × 31
			out = append(out, codeAlphabet[int(b[0])%31])
		}
	}
	return string(out)
}

var codeStrip = regexp.MustCompile(`[\s-]`)

func normCode(c string) string { return codeStrip.ReplaceAllString(strings.ToUpper(c), "") }

// ---------------------------------------------------------------- TOTP (RFC 6238, SHA-1, 30 s, 6 digits)

const totpStep = 30

var b32 = base32.StdEncoding.WithPadding(base32.NoPadding)

func newTOTPSecret() string {
	b := make([]byte, 20)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return b32.EncodeToString(b)
}

func hotp(key []byte, counter int64) string {
	m := hmac.New(sha1.New, key)
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], uint64(counter))
	m.Write(msg[:])
	s := m.Sum(nil)
	o := s[len(s)-1] & 15
	n := (uint32(s[o])&127)<<24 | uint32(s[o+1])<<16 | uint32(s[o+2])<<8 | uint32(s[o+3])
	return fmt.Sprintf("%06d", n%1_000_000)
}

var sixDigits = regexp.MustCompile(`^\d{6}$`)

// totpMatch: the step the code matches within ±1 step, or -1. Steps ≤ after were already used (a code works once).
func totpMatch(secret, code string, after int64, now time.Time) int64 {
	c := strings.Join(strings.Fields(code), "")
	if !sixDigits.MatchString(c) {
		return -1
	}
	key, err := b32.DecodeString(strings.ToUpper(strings.NewReplacer(" ", "", "=", "", "-", "").Replace(secret)))
	if err != nil {
		return -1
	}
	cur := now.Unix() / totpStep
	for s := cur - 1; s <= cur+1; s++ {
		if s <= after {
			continue
		}
		if sameStr(hotp(key, s), c) {
			return s
		}
	}
	return -1
}

func truncRunes(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}
