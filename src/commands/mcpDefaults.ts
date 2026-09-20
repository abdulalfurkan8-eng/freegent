/** The 10 built-in MCP tool packs, installed on first /mcp use. Bodies are
 * recipes the agent runs through run_command / web_fetch - no invented
 * endpoints. Users may edit the files; installs never overwrite. */

const FM = (name: string, desc: string): string =>
  `---\nname: ${name}\ndescription: ${desc}\nenabled: true\nbuiltin: true\n---\n\n`;

export const DEFAULT_MCPS: Record<string, string> = {
  'github': FM('github', 'GitHub repos, issues, PRs, releases via gh CLI or public API') +
`REQUIREMENTS: gh CLI logged in (gh auth login) for private repos; public API needs nothing.

## TOOL: gh_repo_view
USE: inspect a repository (description, topics, latest release).
HOW: run_command: gh repo view <OWNER/REPO> --json name,description,latestRelease
  Fallback without gh: web_fetch https://api.github.com/repos/<OWNER>/<REPO>
OUTPUT: JSON with repo metadata.

## TOOL: gh_issues
USE: list or search issues/PRs.
HOW: run_command: gh issue list -R <OWNER/REPO> --limit 20 --json number,title,state
  PRs: gh pr list -R <OWNER/REPO> --json number,title,state
OUTPUT: JSON array; cite issue numbers in answers.

## TOOL: gh_create
USE: create an issue or PR after the user confirms.
HOW: run_command: gh issue create -R <OWNER/REPO> -t "<TITLE>" -b "<BODY>"
OUTPUT: URL of the created item.
`,

  'filesystem-pro': FM('filesystem-pro', 'Bulk file ops: tree, find, zip, dupes, big-file scan') +
`REQUIREMENTS: none (uses bash + node already present).

## TOOL: fs_tree
USE: show project structure fast.
HOW: run_command: find <DIR> -type f -not -path "*/node_modules/*" -not -path "*/.git/*" | head -100
OUTPUT: file list; summarize by folder.

## TOOL: fs_find_text
USE: find files containing text.
HOW: run_command: grep -rl "<TEXT>" <DIR> --include="*.<EXT>" -I | head -30
OUTPUT: matching file paths.

## TOOL: fs_zip
USE: zip a folder for the user.
HOW: run_command: powershell -Command "Compress-Archive -Path '<DIR>/*' -DestinationPath '<OUT>.zip' -Force"
OUTPUT: zip path; confirm size with ls -la.

## TOOL: fs_big_files
USE: find what is eating disk space.
HOW: run_command: du -a <DIR> 2>/dev/null | sort -rn | head -20
OUTPUT: sizes in KB with paths.
`,

  'fetch-web': FM('fetch-web', 'Fetch any URL as text, download files, check status') +
`REQUIREMENTS: none.

## TOOL: fetch_page
USE: read a web page or API as text.
HOW: web_fetch <URL> (preferred). Fallback: run_command: curl -sL "<URL>" | head -200
OUTPUT: page text; quote only what you actually fetched.

## TOOL: download_file
USE: save a remote file locally.
HOW: run_command: curl -sL -o "<OUT_PATH>" "<URL>" && ls -la "<OUT_PATH>"
OUTPUT: saved path + size; verify non-zero size.

## TOOL: check_status
USE: is a site/API up? what status code?
HOW: run_command: curl -s -o /dev/null -w "%{http_code} %{time_total}s" "<URL>"
OUTPUT: HTTP code + response time.
`,

  'sqlite': FM('sqlite', 'Create and query local SQLite databases (no server needed)') +
`REQUIREMENTS: none (uses node:sqlite via node, or sqlite3 CLI if installed).

## TOOL: sql_query
USE: run SQL against a .db file (create tables, insert, select).
HOW: run_command: node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('<DB_FILE>');console.log(JSON.stringify(d.prepare('<SQL>').all()))"
  For writes use d.exec('<SQL>') instead of prepare().all().
OUTPUT: JSON rows; show as a table to the user.

## TOOL: sql_schema
USE: inspect what tables/columns a database has.
HOW: run_command: node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('<DB_FILE>');console.log(JSON.stringify(d.prepare('SELECT name,sql FROM sqlite_master').all(),null,1))"
OUTPUT: table names + CREATE statements.
`,

  'browser': FM('browser', 'Drive a real browser: screenshot, scrape, test pages (Playwright)') +
`REQUIREMENTS: none (Playwright ships with freegent).

## TOOL: page_screenshot
USE: show the user what a page/localhost app looks like.
HOW: run_command: node -e "const{chromium}=require('playwright');(async()=>{const b=await chromium.launch();const p=await b.newPage();await p.goto('<URL>');await p.screenshot({path:'shot.png',fullPage:true});await b.close()})()"
OUTPUT: shot.png - attach or report the path.

## TOOL: page_text
USE: scrape rendered text from a JS-heavy page web_fetch cannot read.
HOW: run_command: node -e "const{chromium}=require('playwright');(async()=>{const b=await chromium.launch();const p=await b.newPage();await p.goto('<URL>');console.log((await p.innerText('body')).slice(0,4000));await b.close()})()"
OUTPUT: visible page text.

## TOOL: page_test
USE: verify a site the agent built actually renders without errors.
HOW: use the built-in test_page tool on the local file or URL.
OUTPUT: console errors + render check.
`,

  'terminal-pro': FM('terminal-pro', 'Ports, processes, services, env - beyond basic commands') +
`REQUIREMENTS: none.

## TOOL: port_check
USE: what is running on a port / is my dev server up?
HOW: run_command: netstat -ano | grep ":<PORT>" | head -5
OUTPUT: LISTENING lines with PID; empty means the port is free.

## TOOL: proc_kill
USE: stop a stuck process by PID (confirm with the user first).
HOW: run_command: taskkill //PID <PID> //F
OUTPUT: success/failure message.

## TOOL: env_get
USE: check whether an env var / API key is configured.
HOW: run_command: node -e "console.log(process.env.<NAME> ? 'SET' : 'NOT SET')"
OUTPUT: SET or NOT SET - never print the actual secret.

## TOOL: serve_dir
USE: preview a static site the agent built.
HOW: use the run_background tool: npx serve <DIR> -l <PORT> - then test_page http://localhost:<PORT>
OUTPUT: local URL for the user.
`,

  'npm-packages': FM('npm-packages', 'Search npm, check versions, audit and install dependencies') +
`REQUIREMENTS: none (npm ships with node).

## TOOL: npm_search
USE: find the right package for a job.
HOW: run_command: npm search <QUERY> --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{JSON.parse(s).slice(0,5).forEach(p=>console.log(p.name,'|',p.version,'|',(p.description||'').slice(0,80)))})"
OUTPUT: top 5 name | version | description.

## TOOL: npm_info
USE: latest version + weekly downloads before recommending a package.
HOW: run_command: npm view <PACKAGE> version description homepage
OUTPUT: registry metadata.

## TOOL: npm_audit
USE: check a project for vulnerable dependencies.
HOW: run_command: npm audit --json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const a=JSON.parse(s);console.log('vulns:',JSON.stringify(a.metadata&&a.metadata.vulnerabilities))})"
OUTPUT: counts by severity; suggest npm audit fix when non-zero.
`,

  'google-search': FM('google-search', 'Live web search results without any API key') +
`REQUIREMENTS: none.

## TOOL: web_search
USE: find current pages/answers when you do not know the URL. Use BEFORE
  guessing URLs in research phases.
HOW: run_command: curl -sL "https://html.duckduckgo.com/html/?q=<QUERY+WITH+PLUSES>" | grep -oE 'result__a[^>]*href="[^"]*"[^>]*>[^<]*' | head -10
  Then web_fetch the best result URLs to read them.
OUTPUT: result links + titles; ALWAYS follow up by fetching 2-3 of them.

## TOOL: search_news
USE: recent news/updates on a topic.
HOW: run_command: curl -sL "https://html.duckduckgo.com/html/?q=<QUERY>+<CURRENT_YEAR>" | grep -oE 'result__a[^>]*href="[^"]*"[^>]*>[^<]*' | head -10
OUTPUT: links to fetch with web_fetch.
`,

  'api-tester': FM('api-tester', 'Send HTTP requests like a mini Postman: GET/POST, headers, auth') +
`REQUIREMENTS: none.

## TOOL: http_get
USE: test/read any API endpoint.
HOW: run_command: curl -s -w "\nSTATUS %{http_code} TIME %{time_total}s" -H "Accept: application/json" "<URL>"
OUTPUT: body + status + timing; pretty-print JSON for the user.

## TOOL: http_post
USE: send JSON to an API (test backends the user builds).
HOW: run_command: curl -s -w "\nSTATUS %{http_code}" -X POST -H "Content-Type: application/json" -d '<JSON_BODY>' "<URL>"
OUTPUT: response body + status.

## TOOL: http_auth
USE: call an endpoint that needs a bearer token.
HOW: run_command: curl -s -w "\nSTATUS %{http_code}" -H "Authorization: Bearer <TOKEN>" "<URL>"
  Read tokens from env: -H "Authorization: Bearer $<ENV_NAME>" - never hardcode.
OUTPUT: response + status; on 401/403 tell the user which credential to set.
`,
};