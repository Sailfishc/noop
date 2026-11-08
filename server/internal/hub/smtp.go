package hub

import (
	"crypto/tls"
	"encoding/base64"
	"fmt"
	"net"
	"net/smtp"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// SMTPConfig is noop's [email] block (HUB_SMTP): {host, port, secure, user, pass, from}.
type SMTPConfig struct {
	Host   string `json:"host"`
	Port   int    `json:"port"`
	Secure *bool  `json:"secure"`
	User   string `json:"user"`
	Pass   string `json:"pass"`
	From   string `json:"from"`
}

var angleAddr = regexp.MustCompile(`<([^>]+)>`)

// Send one plain-text mail. Port 465 (or secure: true) is implicit TLS; anything else upgrades with STARTTLS when the
// server offers it.
func (c SMTPConfig) Send(to, subject, text string) error {
	port := c.Port
	if port == 0 {
		port = 465
	}
	secure := port == 465
	if c.Secure != nil {
		secure = *c.Secure
	}
	addr := net.JoinHostPort(c.Host, strconv.Itoa(port))
	from := c.From
	if from == "" {
		from = c.User
	}
	envFrom := from
	if m := angleAddr.FindStringSubmatch(from); m != nil {
		envFrom = m[1]
	}
	d := &net.Dialer{Timeout: 15 * time.Second}
	var conn net.Conn
	var err error
	if secure {
		conn, err = tls.DialWithDialer(d, "tcp", addr, &tls.Config{ServerName: c.Host})
	} else {
		conn, err = d.Dial("tcp", addr)
	}
	if err != nil {
		return err
	}
	_ = conn.SetDeadline(time.Now().Add(30 * time.Second))
	cl, err := smtp.NewClient(conn, c.Host)
	if err != nil {
		conn.Close()
		return err
	}
	defer cl.Close()
	if !secure {
		if ok, _ := cl.Extension("STARTTLS"); ok {
			if err := cl.StartTLS(&tls.Config{ServerName: c.Host}); err != nil {
				return err
			}
		}
	}
	if c.User != "" {
		if err := cl.Auth(smtp.PlainAuth("", c.User, c.Pass, c.Host)); err != nil {
			return err
		}
	}
	if err := cl.Mail(envFrom); err != nil {
		return err
	}
	if err := cl.Rcpt(to); err != nil {
		return err
	}
	w, err := cl.Data()
	if err != nil {
		return err
	}
	b64 := func(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }
	host := envFrom[strings.LastIndex(envFrom, "@")+1:]
	msg := strings.Join([]string{
		"From: " + from, "To: " + to, "Subject: =?UTF-8?B?" + b64(subject) + "?=",
		fmt.Sprintf("Message-ID: <%s@%s>", uuid4(), host), "Date: " + time.Now().Format(time.RFC1123Z),
		"MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", wrap76(b64(text)), "",
	}, "\r\n")
	if _, err := w.Write([]byte(msg)); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	return cl.Quit()
}

func wrap76(s string) string {
	var b strings.Builder
	for len(s) > 76 {
		b.WriteString(s[:76])
		b.WriteString("\r\n")
		s = s[76:]
	}
	b.WriteString(s)
	return b.String()
}
