/* OAK Beauty - shared Tailwind design tokens.
   Load AFTER assets/js/tailwind-36d3755fef.js and BEFORE any markup. */
tailwind.config = {
    "darkMode": "class",
    "theme": {
        "extend": {
            "colors": {
                "primary": "#171818",
                "on-primary": "#ffffff",
                "primary-container": "#2c2c2c",
                "on-primary-container": "#949393",
                "primary-fixed": "#e4e2e1",
                "primary-fixed-dim": "#c8c6c5",
                "on-primary-fixed": "#1b1c1c",
                "on-primary-fixed-variant": "#474747",
                "inverse-primary": "#c8c6c5",
                "secondary": "#924c00",
                "on-secondary": "#ffffff",
                "secondary-container": "#fda055",
                "on-secondary-container": "#703800",
                "secondary-fixed": "#ffdcc4",
                "secondary-fixed-dim": "#ffb781",
                "on-secondary-fixed": "#2f1400",
                "on-secondary-fixed-variant": "#6f3800",
                "tertiary": "#1b1708",
                "on-tertiary": "#ffffff",
                "tertiary-container": "#302c1a",
                "on-tertiary-container": "#9a937c",
                "tertiary-fixed": "#ebe2c8",
                "tertiary-fixed-dim": "#cec6ad",
                "on-tertiary-fixed": "#1f1c0b",
                "on-tertiary-fixed-variant": "#4c4733",
                "error": "#ba1a1a",
                "on-error": "#ffffff",
                "error-container": "#ffdad6",
                "on-error-container": "#93000a",
                "background": "#fff8f4",
                "on-background": "#291800",
                "surface": "#fff8f4",
                "on-surface": "#291800",
                "surface-variant": "#ffddb2",
                "on-surface-variant": "#444748",
                "surface-tint": "#5f5e5e",
                "surface-dim": "#f6d5aa",
                "surface-bright": "#fff8f4",
                "surface-container-lowest": "#ffffff",
                "surface-container-low": "#fff1e4",
                "surface-container": "#ffebd3",
                "surface-container-high": "#ffe4c3",
                "surface-container-highest": "#ffddb2",
                "inverse-surface": "#402d0f",
                "inverse-on-surface": "#ffeedc",
                "outline": "#747878",
                "outline-variant": "#c4c7c7"
            },
            "borderRadius": {
                "DEFAULT": "0.125rem",
                "lg": "0.25rem",
                "xl": "0.5rem",
                "full": "0.75rem"
            },
            "spacing": {
                "gutter": "24px",
                "margin-mobile": "16px",
                "margin-desktop": "64px",
                "base": "8px",
                "section-gap": "120px",
                "container-max": "1280px"
            },
            "fontFamily": {
                "display-lg": ["Fraunces", "Playfair Display", "serif"],
                "headline-lg": ["Fraunces", "Playfair Display", "serif"],
                "headline-lg-mobile": ["Fraunces", "Playfair Display", "serif"],
                "headline-md": ["Fraunces", "Playfair Display", "serif"],
                "headline-sm": ["Fraunces", "Playfair Display", "serif"],
                "body-lg": ["Inter"],
                "body-md": ["Inter"],
                "label-md": ["Inter"],
                "caption": ["Inter"]
            },
            "fontSize": {
                "display-lg": ["64px", { "lineHeight": "1.1", "letterSpacing": "-0.02em", "fontWeight": "700" }],
                "headline-lg": ["48px", { "lineHeight": "1.2", "fontWeight": "600" }],
                "headline-lg-mobile": ["32px", { "lineHeight": "1.2", "fontWeight": "600" }],
                "headline-md": ["32px", { "lineHeight": "1.3", "fontWeight": "500" }],
                "headline-sm": ["24px", { "lineHeight": "1.4", "fontWeight": "500" }],
                "body-lg": ["18px", { "lineHeight": "1.6", "fontWeight": "400" }],
                "body-md": ["16px", { "lineHeight": "1.6", "fontWeight": "400" }],
                "label-md": ["14px", { "lineHeight": "1.0", "letterSpacing": "0.05em", "fontWeight": "600" }],
                "caption": ["12px", { "lineHeight": "1.4", "fontWeight": "400" }]
            }
        }
    }
};
