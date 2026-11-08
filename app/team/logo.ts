// TeamAgent's mark, the same drawing as icon.png (a person and an agent side by side), for the sign-in screen.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="824" height="824" viewBox="100 100 824 824">
<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4466FF"/><stop offset="1" stop-color="#1D2789"/></linearGradient>
<linearGradient id="ag" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#86F7DA"/><stop offset="1" stop-color="#26CFA3"/></linearGradient></defs>
<rect x="100" y="100" width="824" height="824" rx="185" fill="url(#bg)"/>
<circle cx="410" cy="420" r="150" fill="#FFFFFF"/>
<rect x="474" y="464" width="290" height="290" rx="80" fill="url(#ag)" stroke="#2C3CC9" stroke-width="24"/>
<path d="M619 527 L644 584 L701 609 L644 634 L619 691 L594 634 L537 609 L594 584 Z" fill="#14206B"/>
</svg>`;
export const LOGO = `data:image/svg+xml,${encodeURIComponent(SVG)}`;
