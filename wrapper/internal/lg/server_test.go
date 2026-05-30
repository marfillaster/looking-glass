package lg

import "testing"

func TestSanitizeSSEData(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "strips CSI color escapes",
			in:   "hop \x1b[31mred\x1b[0m done",
			want: "hop red done",
		},
		{
			name: "strips OSC title escapes",
			in:   "before \x1b]0;owned\x07 after",
			want: "before  after",
		},
		{
			name: "prevents SSE line injection",
			in:   "first\nevent: done\rdata: nope",
			want: "first event: done data: nope",
		},
		{
			name: "drops C0 controls except tab",
			in:   "a\x00b\tc\x7fd",
			want: "ab\tcd",
		},
		{
			name: "keeps unicode text",
			in:   "münchen 2606:4700:4700::1111",
			want: "münchen 2606:4700:4700::1111",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := sanitizeSSEData(tc.in); got != tc.want {
				t.Fatalf("sanitizeSSEData(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}
