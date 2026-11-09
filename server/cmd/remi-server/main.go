// remi-server: Remi's server, for its people's apps and their machines.
//
//	remi-server -addr :8080 -data /var/lib/remi
//
//	remi-server invite -data /var/lib/remi -email you@company.com -role admin
//
//	remi-server -addr :8080 -public-url http://remi.corp:8080   # the address others use
//
// The invite prints a link: the first admin opens it in the app, which signs them in, and invites everyone else
// from the app. Each person adds their machines there and puts each machine's token in its config.local.toml
// ([cloud] url = "http://<host>:8080", [server] token = "tam_…"). Every REMI_* variable may also be spelled
// TEAMAGENT_*.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/Sailfishc/noop/server/internal/hub"
)

// env reads REMI_<k>, or TEAMAGENT_<k> as the product was first called, so older deployments keep working.
func env(k, def string) string {
	for _, prefix := range []string{"REMI_", "TEAMAGENT_"} {
		if v := os.Getenv(prefix + k); v != "" {
			return v
		}
	}
	return def
}

func invite(args []string) {
	fs := flag.NewFlagSet("invite", flag.ExitOnError)
	data := fs.String("data", env("DATA", "./data"), "directory for the SQLite database")
	email := fs.String("email", "", "the person's email")
	role := fs.String("role", "admin", "admin or member")
	base := fs.String("url", env("PUBLIC_URL", env("URL", "")), "the server's public address, to print a full link")
	_ = fs.Parse(args)
	if err := os.MkdirAll(*data, 0o700); err != nil {
		log.Fatal(err)
	}
	db, err := hub.OpenDB(filepath.Join(*data, "hub.db"))
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	code, err := hub.New(hub.Config{}, db).CreateInvite(*email, *role, "")
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("邀请 %s（%s），7 天内有效：\n  %s/invite/%s\n", *email, *role, strings.TrimRight(*base, "/"), code)
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "invite" {
		invite(os.Args[2:])
		return
	}
	addr := flag.String("addr", env("ADDR", ":8080"), "listen address")
	data := flag.String("data", env("DATA", "./data"), "directory for the SQLite database")
	static := flag.String("static", env("STATIC", ""), "web client directory (app/dist/web/noop); empty: API only")
	public := flag.String("public-url", env("PUBLIC_URL", ""), "the address others reach this server at (http://remi.corp:8080), used in invite links, login links and machine install commands; empty: each app uses the address it connected to")
	hookSecret := flag.String("git-webhook-secret", env("GIT_WEBHOOK_SECRET", ""), "secret of the Ant Code / GitLab webhook (POST /api/v1/hooks/gitlab); empty: off")
	flag.Parse()

	if err := os.MkdirAll(*data, 0o700); err != nil {
		log.Fatal(err)
	}
	db, err := hub.OpenDB(filepath.Join(*data, "hub.db"))
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()

	pub := strings.TrimRight(strings.TrimSpace(*public), "/")
	if pub != "" && !strings.HasPrefix(pub, "http://") && !strings.HasPrefix(pub, "https://") {
		log.Fatal("-public-url must start with http:// or https://")
	}
	h := hub.New(hub.Config{PublicURL: pub, StaticDir: *static, GitWebhookSecret: *hookSecret}, db)

	srv := &http.Server{Addr: *addr, Handler: h, ReadHeaderTimeout: 10 * time.Second}
	go func() { // waiting tasks (timers, deadlines) and reminders
		for range time.Tick(30 * time.Second) {
			h.Tick()
		}
	}()
	go func() {
		log.Printf("remi-server listening on %s (data %s, public url %q)", *addr, *data, pub)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}
