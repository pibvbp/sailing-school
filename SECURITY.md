# Security policy

## Supported versions

Only the live site, <https://pibvbp.github.io/sailing-school/>, and the `main` branch are supported. Fixes land on
`main` and are deployed to the site from there; older versions are not maintained.

## Scope

Sailing School is a static site: HTML, CSS and JavaScript served by GitHub Pages. It has no server, database, accounts,
cookies or analytics. Once loaded, the app makes no network requests. The only thing it stores is lesson progress, in
the browser's `localStorage`.

**In scope:**

- Anything in this repository's code that could harm a visitor, such as script injection through the page (URL
  parameters, the rendering of lesson or glossary text, the HUD), or a way to make the page do something a visitor
  didn't expect.
- The build and deployment pipeline: the GitHub Actions workflows in [`.github/workflows`](.github/workflows), and
  the dependencies that end up in the published site.
- Secrets committed to the repository by mistake.

**Out of scope:**

- GitHub, GitHub Pages and web browsers themselves: please report those to their owners.
- Heavy GPU or CPU load from the 3-D scene. Please report performance problems as ordinary issues.
- Attacks that need an already-compromised device or browser, or a malicious browser extension.
- Social engineering and spam.
- Automated scanner output without a demonstrated impact, including missing HTTP headers that GitHub Pages controls.

## Reporting a vulnerability

Please **don't** open a public issue. Report it privately instead:

1. Open the repository's **Security** tab and choose **Report a vulnerability**, or go straight to
   <https://github.com/pibvbp/sailing-school/security/advisories/new>. This is GitHub's private vulnerability
   reporting; only the maintainers can see your report.
2. Tell us:
   - what the problem is and what an attacker could do with it;
   - how to reproduce it, ideally with a proof of concept;
   - the affected URL, commit or file, and your browser and operating system if they matter;
   - whether you would like to be credited.

## What to expect

This is a volunteer project, handled on a best-effort basis: there are no guaranteed response times. We will:

- acknowledge your report and tell you whether we can reproduce the problem and how serious we think it is, as soon as
  we can;
- fix confirmed problems as quickly as their severity calls for, and deploy the fix to the live site;
- keep you informed along the way, and credit you in the advisory and the [changelog](CHANGELOG.md) if you wish.

There is no bug bounty. Please give us a reasonable time to fix a problem before you disclose it publicly; we will
agree a disclosure date with you.
