package hub

import (
	"bytes"
	"database/sql"
	"image"
	"image/draw"
	"image/gif"
	"image/jpeg"
	"image/png"
	"path"
	"strings"
	"unicode/utf8"
)

// Previews of attached files, so a channel does not load every picture whole or make you open a log to see it:
// pictures get a thumbnail at most 480px on a side (PNG, JPEG, GIF's first frame; the standard library only, made the
// first time someone looks and kept), text files their first 40 lines. Other files show name, type and size.

const (
	thumbMax          = 480
	maxThumbSource    = 40 << 20 // larger pictures are shown as they are
	maxThumbPixels    = 50_000_000
	previewLines      = 40
	previewBytes      = 4 << 10
	previewScanBytes  = 64 << 10
	thumbsSchemaTable = `CREATE TABLE IF NOT EXISTS thumbs (id TEXT PRIMARY KEY, type TEXT NOT NULL, data BLOB, width INTEGER NOT NULL,
  height INTEGER NOT NULL);`
)

// textish: a file worth showing as text, by type or by name.
var textExts = map[string]bool{".md": true, ".markdown": true, ".txt": true, ".log": true, ".csv": true, ".tsv": true, ".json": true,
	".yaml": true, ".yml": true, ".toml": true, ".ini": true, ".conf": true, ".xml": true, ".sql": true, ".sh": true, ".diff": true,
	".patch": true, ".go": true, ".ts": true, ".tsx": true, ".js": true, ".jsx": true, ".py": true, ".rb": true, ".java": true,
	".kt": true, ".swift": true, ".rs": true, ".c": true, ".h": true, ".cc": true, ".cpp": true, ".cs": true, ".php": true, ".css": true,
	".html": true, ".vue": true, ".proto": true, ".env.example": true, ".gradle": true, ".lua": true, ".scala": true}

func textish(typ, name string) bool {
	if strings.HasPrefix(typ, "text/") || typ == "application/json" || typ == "application/xml" || strings.HasSuffix(typ, "+json") {
		return true
	}
	return textExts[strings.ToLower(path.Ext(name))]
}

// textPreview: the first lines of a text file, and whether there is more. "" when it does not read as text.
func textPreview(head []byte, size int) (string, bool) {
	if bytes.IndexByte(head, 0) >= 0 {
		return "", false
	}
	cut := head
	more := size > len(head)
	lines := 0
	for i, c := range cut {
		if c == '\n' {
			lines++
			if lines == previewLines {
				more = more || i+1 < len(cut)
				cut = cut[:i]
				break
			}
		}
	}
	if len(cut) > previewBytes {
		cut, more = cut[:previewBytes], true
	}
	for len(cut) > 0 && !utf8.Valid(cut) { // a rune cut in half at the end
		cut = cut[:len(cut)-1]
	}
	if !utf8.Valid(cut) {
		return "", false
	}
	return strings.TrimRight(string(cut), "\r\n"), more
}

// mediaHead: the first bytes of an attachment (its first chunks).
func (h *Hub) mediaHead(id string, n int) []byte {
	rows, err := h.db.Query("SELECT data FROM media WHERE id = ? ORDER BY n", id)
	if err != nil {
		panic(err)
	}
	defer rows.Close()
	var buf bytes.Buffer
	for rows.Next() && buf.Len() < n {
		var d []byte
		if err := rows.Scan(&d); err != nil {
			panic(err)
		}
		buf.Write(d)
	}
	b := buf.Bytes()
	return b[:min(len(b), n)]
}

type thumb struct {
	typ           string
	data          []byte // nil: the picture is small enough as it is
	width, height int    // the picture's own size
}

// thumbOf: the attachment's thumbnail, made now if it was not yet. ok=false: not a picture we can read.
func (h *Hub) thumbOf(id, typ string, size int) (thumb, bool) {
	if !strings.HasPrefix(typ, "image/") {
		return thumb{}, false
	}
	var t thumb
	err := h.db.QueryRow("SELECT type, data, width, height FROM thumbs WHERE id = ?", id).Scan(&t.typ, &t.data, &t.width, &t.height)
	if err == nil {
		return t, t.width > 0
	}
	if err != sql.ErrNoRows {
		panic(err)
	}
	t = makeThumb(typ, size, func() []byte { return h.mediaHead(id, size) })
	h.must(h.db.Exec("INSERT OR REPLACE INTO thumbs (id, type, data, width, height) VALUES (?, ?, ?, ?, ?)", id, t.typ, t.data, t.width, t.height))
	return t, t.width > 0
}

func makeThumb(typ string, size int, read func() []byte) thumb {
	if typ != "image/png" && typ != "image/jpeg" && typ != "image/gif" || size > maxThumbSource {
		return thumb{}
	}
	b := read()
	cfg, _, err := image.DecodeConfig(bytes.NewReader(b))
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width*cfg.Height > maxThumbPixels {
		return thumb{}
	}
	t := thumb{typ: typ, width: cfg.Width, height: cfg.Height}
	if cfg.Width <= thumbMax && cfg.Height <= thumbMax {
		return t // small already: the picture itself
	}
	var src image.Image
	switch typ {
	case "image/png":
		src, err = png.Decode(bytes.NewReader(b))
	case "image/jpeg":
		src, err = jpeg.Decode(bytes.NewReader(b))
	case "image/gif":
		src, err = gif.Decode(bytes.NewReader(b)) // the first frame
	}
	if err != nil {
		return thumb{}
	}
	small := shrink(src, thumbMax)
	var out bytes.Buffer
	if typ == "image/jpeg" {
		err = jpeg.Encode(&out, small, &jpeg.Options{Quality: 82})
	} else {
		t.typ = "image/png"
		err = png.Encode(&out, small)
	}
	if err != nil {
		return thumb{}
	}
	t.data = out.Bytes()
	return t
}

// shrink scales a picture down to fit limit×limit, averaging the pixels each new one covers (good enough for a preview).
func shrink(src image.Image, limit int) *image.RGBA {
	b := src.Bounds()
	sw, sh := b.Dx(), b.Dy()
	dw, dh := limit, sh*limit/sw
	if sh > sw {
		dw, dh = sw*limit/sh, limit
	}
	dw, dh = max(dw, 1), max(dh, 1)
	rgba, ok := src.(*image.RGBA)
	if !ok {
		rgba = image.NewRGBA(image.Rect(0, 0, sw, sh))
		draw.Draw(rgba, rgba.Bounds(), src, b.Min, draw.Src)
	} else if b.Min != (image.Point{}) {
		c := image.NewRGBA(image.Rect(0, 0, sw, sh))
		draw.Draw(c, c.Bounds(), src, b.Min, draw.Src)
		rgba = c
	}
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	for y := 0; y < dh; y++ {
		y0, y1 := y*sh/dh, max((y+1)*sh/dh, y*sh/dh+1)
		for x := 0; x < dw; x++ {
			x0, x1 := x*sw/dw, max((x+1)*sw/dw, x*sw/dw+1)
			var r, g, bl, a, n uint64
			for sy := y0; sy < y1; sy++ {
				row := rgba.Pix[sy*rgba.Stride:]
				for sx := x0; sx < x1; sx++ {
					p := row[sx*4 : sx*4+4]
					r, g, bl, a, n = r+uint64(p[0]), g+uint64(p[1]), bl+uint64(p[2]), a+uint64(p[3]), n+1
				}
			}
			o := dst.Pix[y*dst.Stride+x*4:]
			o[0], o[1], o[2], o[3] = uint8(r/n), uint8(g/n), uint8(bl/n), uint8(a/n)
		}
	}
	return dst
}
