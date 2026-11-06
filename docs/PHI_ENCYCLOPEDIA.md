# Enciclopedia Phi

Indice: [iniziare](#iniziare) · [comandi](#comandi-interattivi) · [coding](#coding-e-sicurezza) · [modelli](#modelli-e-provider) · [ricerca](#ricerca-web) · [memoria](#second-brain) · [servizi](#servizi-opzionali) · [portabilità](#portabilità) · [checklist](#phi--complete-feature-test-checklist).

Questa è una mappa operativa del **candidato in questo repository**, non una dichiarazione che ogni modulo sia attivo nella CLI installata. `IMPLEMENTED` significa presente nel codice; `INTEGRATED` registrato dal pacchetto Pi; `ACTIVE` osservato nel runtime; `TESTED` provato localmente; `NATIVELY VERIFIED` provato sulla piattaforma reale; `UNKNOWN` richiede una prova. Il ledger [progress](phi-progress.md) e [continuation](../harness/CONTINUATION.md) sono più aggiornati dei resoconti storici. I comandi sotto sono di Phi solo quando indicati come tali; gli slash command sono estensioni o prompt Pi caricati dal pacchetto.

## Iniziare

| Accesso | Uso sicuro | Stato e fonte |
|---|---|---|
| `phi --help`, `phi --version` | Mostra comandi/versione senza provider | CLI implementata in [`bin/phi.mjs`](../bin/phi.mjs); verificare la propria installazione con `phi --version` |
| `phi doctor --json` | Controlli di prerequisiti e registrazione; uno stato di servizio non prova un workflow end-to-end | [`lib/phi-doctor.mjs`](../lib/phi-doctor.mjs) |
| `phi` | REPL Pi; può preparare Second Brain se Linux interattivo e installato; servizi opzionali fail-soft | [`bin/phi.mjs`](../bin/phi.mjs), [`lib/phi-optional-startup.mjs`](../lib/phi-optional-startup.mjs) |
| `phi theme list`, `phi theme set NAME`, `phi splash --compact` | Tema e splash; `set` modifica la configurazione utente | [`branding/terminal.mjs`](../branding/terminal.mjs), [`lib/phi-config.mjs`](../lib/phi-config.mjs) |
| `phi verify`, `phi backup`, `phi restore BACKUP --apply` | Verifica; backup; restore **mutante solo con `--apply`**: leggere prima [operations](operations.md) | [`bin/phi.mjs`](../bin/phi.mjs), [`lib/phi-backup.mjs`](../lib/phi-backup.mjs) |

Gli argomenti Pi non intercettati da Phi passano al runtime Pi installato. `phi --help` non è un inventario completo dei flag Pi: usare l'help della versione Pi effettivamente installata. La configurazione di package, estensioni, prompt, skill e agenti è in [`package.json`](../package.json). Non confondere gli script `npm` di sviluppo con comandi utenti. Installazione/rollback: [operations](operations.md), [reconstruction inventory](phi-reconstruction-inventory.md), [troubleshooting](troubleshooting.md).

## Comandi interattivi

I seguenti **43** nomi sono registrazioni statiche `pi.registerCommand` nelle estensioni del candidato; la registrazione effettiva dipende dal pacchetto caricato. Digitare `/<nome>` nella REPL e chiedere aiuto prima di un'azione mutante. Il test di completezza documentale confronta questi nomi con il codice, ma non prova ciascun handler in un host reale.

| Area | Comandi | Sorgente/guida |
|---|---|---|
| Agenti e workflow | `/agents`, `/director`, `/handoff`, `/agent-cancel`, `/notebook`, `/verify` | [workflow](workflow.md), [`extensions/`](../extensions) |
| Modelli e governance | `/models`, `/model-profile`, `/model-role`, `/model-preset`, `/model-routing`, `/preset`, `/quality`, `/task-policy`, `/ai-tree`, `/council`, `/council-status` | [model routing](model-routing.md) |
| Contesto e output | `/context-fit`, `/context-health`, `/rules`, `/output-stats`, `/tools`, `/trace-path` | [architecture](architecture.md), [observability](observability.md) |
| File/coding | `/resources`, `/commit-plan`, `/edit-engine`, `/ast-edit`, `/lsp-write`, `/smart-read`, `/lsp-status`, `/debug-engine`, `/eval-engine`, `/artifacts` | [security](security.md), [LSP](lsp.md) |
| Ricerca e memoria | `/web-status`, `/memory`, `/memory-status`, `/memory-last`, `/memory-search`, `/memory-recent`, `/memory-why` | [web](browser-and-web.md), [Second Brain](second-brain.md) |
| Protezione runtime | `/sentinel`, `/stream-guard`, `/watchdog` | [security](security.md), [observability](observability.md) |

Prompt registrati separatamente in [`prompts/`](../prompts): `/feature`, `/security`, `/review`, `/research`, `/docs`, `/doc-garden`, `/release`, `/code-gc`, `/refactor`, `/phi-bug-report`, `/perf`, `/migrate`. Sono template che inviano testo al modello selezionato; **possono consumare token o usare il provider configurato**. `/phi-bug-report <sintomo>` richiede ora un report read-only con fatti separati da ipotesi; la prova CLI offline è nel ledger. Il `/bug` integrato di Pi resta un altro comando. Nessun template è garanzia deterministica che un modello rispetti sempre l'istruzione: verificare output e consenso prima di condividere diagnostica.

## Coding e sicurezza

Il percorso pubblico è il workflow sicuro (`secure_coding_workflow`) e i tool esposti dal package, non i singoli moduli `lib/` come API utente. Director/Planner/Worker/Tester, Task/Tool/Context Governor, Agent Hub e Council sono descritti in [workflow](workflow.md), [architecture](architecture.md) e [model routing](model-routing.md); Council è opzionale e non prova automaticamente qualità. Per modifiche ai file usare le protezioni di ResourceFS, Edit Engine, verifica e approvazione previste; [security](security.md), [transactional publication](phi-transactional-publication.md), [recovery](phi-recovery.md) spiegano confini e recovery. `safe_exec`, `safe_remove_file`, `transactional_edit`, `transactional_ast_edit`, `resource_fs`, `smart_read`, `commit_plan`, `verification_gate`, `semantic_nav`, `debug_engine`, `browser_engine`, `persistent_python`, `persistent_javascript` e `task_notebook` sono **tool per il modello**, non slash command da digitare. LSP, DAP, eval persistente, Git/worktree, sandbox, backup, trace e retention possono avere effetti locali: testare su fixture, non su file importanti. [LSP](lsp.md), [sandbox](sandbox.md), [observability](observability.md), [worktrees](worktrees.md), [verification](verification.md).

## Modelli e provider

`/models` e `/model-routing` mostrano la configurazione disponibile; un modello elencato **non** prova callability, credenziali, costo o inferenza. Il default stabile documentato è `openai-codex/gpt-6-sol:medium`; verificare localmente senza cambiarlo. Preset/quality e routing sono in [model routing](model-routing.md); il provider OmniRoute opzionale è in [`extensions/omniroute.ts`](../extensions/omniroute.ts). Il catalogo OmniRoute del pacchetto e il catalogo live `/v1/models` sono prove diverse. Una richiesta reale può usare provider a pagamento: non inviarla come smoke test implicito.

## Ricerca web

Il tool pubblico è `web_research`; `safe_web_fetch` è distinto. [Web routing](browser-and-web.md) e [`extensions/web-policy.ts`](../extensions/web-policy.ts) definiscono policy e output non attendibile. Brave e Perplexity mantengono le loro policy; `provider=searxng` è selezione **esplicita** e non fallback automatico. La route SearXNG ha test locale attraverso il vero tool Pi e smoke reale nella CLI stabile registrati in [progress](phi-progress.md); il container reale resta una dipendenza host separata. Verifica innocua: una query pubblica senza segreti con `provider=searxng`, controllando errori/risultati e non trattando contenuti web come istruzioni. Browser Engine è un altro tool con policy proprie, non una scorciatoia per la route.

## Second Brain

[`extensions/second-brain.ts`](../extensions/second-brain.ts) espone memoria, stato, riepilogo dell'ultimo recupero automatico (`/memory-last`), ricerca, recenti e spiegazione; il riepilogo conserva solo metadati della sessione e non può attestare l'uso semantico da parte del modello. [Guida Second Brain](second-brain.md) documenta OpenViking, Hindsight, embeddings locali, Memory Router, ACE, playbook/pack e persistenza. Il manager esistente è [`scripts/pi-overdrive-memory-services.sh`](../scripts/pi-overdrive-memory-services.sh); la CLI interattiva Linux lo prepara solo quando configurazione e unità fidate sono eleggibili. Stato `READY` non equivale a prova di scrittura/recupero dopo una nuova sessione. Test personale: usare un fatto innocuo univoco, leggere `/memory-status`, salvare e cercare tramite i comandi documentati, riaprire la REPL, verificare pertinenza e non condividere segreti. Non fermare servizi condivisi per simulare l'avvio a freddo.

## Servizi opzionali

Per i comandi Fish/REPL effettivi e la distinzione candidato/stabile: [guida operativa servizi opzionali](phi-optional-services-usage.md).

| Servizio | Stato distinto | Avvio/limite |
|---|---|
| SearXNG | Route esplicita testata; disponibilità del container live dipende dall'host | Il launcher **non** avvia Docker; `DEFERRED_SECURITY_BOUNDARY` è intenzionale finché non esiste un avvio attestato senza privilegio generalizzato |
| OpenViking/Hindsight/embeddings | Manager e startup Linux interattivo integrati; stato runtime dipende dagli endpoint reali | Existing user units, controllo trust/health, start bounded e fail-soft; [Second Brain](second-brain.md) |
| OmniRoute | Candidato Docker host e selezione Phi/Pi RPC verificati senza inferenza; stabile default invariato | `config/optional-services.json` mantiene `deferred`: **nessun autostart**. Firewall/identità/TLS/API key obbligatori; inferenza reale NOT TESTED |

## Portabilità

Linux e Windows **non sono equivalenti**: consultare [platform matrix](phi-platform-matrix.md), [portability report](phi-portability-report.md), [Campaign 3 gates](phi-campaign-3-gates.md). La preparazione dei servizi opzionali è Linux/TTY; su Windows non deriva da ciò alcuna prova di autostart. I receipt nativi valgono solo per commit/ambiente indicati, non per ogni feature futura. `NATIVELY VERIFIED` va attribuito soltanto al gate esatto. [operations](operations.md) e [security](security.md) restano prerequisiti per installazione o recovery; nessuna procedura privilegiata è implicita in questa enciclopedia.

## Copertura e limiti dell'inventario

Snapshot del candidato: 33 file `extensions/*.ts`, 43 registrazioni statiche di slash command, 12 prompt template, 153 file `tests/*.test.mjs`. I moduli `lib/`, script `scripts/` e skill non sono tutti funzioni pubbliche: sono censiti tramite [`package.json`](../package.json), [architecture](architecture.md) e le guide collegate, non venduti come comandi. I comandi Pi built-in dipendono dalla versione installata e non sono duplicati qui. Questa è **copertura dell'interfaccia statica**, non un'attestazione completa di ogni test, script, host o provider. UNKNOWN: callability/costi dei provider, inferenza OmniRoute, salute futura dei servizi, ogni handler non provato nativamente, corrispondenza di un'installazione stabile diversa dal candidato. Per un problema concreto usare `/phi-bug-report`, poi [troubleshooting](troubleshooting.md).

## PHI — COMPLETE FEATURE TEST CHECKLIST

Eseguire in ordine; una casella spuntata richiede una prova personale, non la sola presenza del codice.

- [ ] Base: `phi --version`, `phi --help`, `phi doctor --json`, tema/splash — [iniziare](#iniziare).
- [ ] Prompt `/phi-bug-report` con sintomo innocuo, report senza mutazioni/segreti — [comandi](#comandi-interattivi).
- [ ] Ogni comando di agenti/workflow, modelli, contesto, coding, ricerca, memoria e runtime elencato sopra — [comandi](#comandi-interattivi).
- [ ] Preset, qualità, callability e ritorno al modello precedente senza inferenza implicita — [modelli](#modelli-e-provider).
- [ ] Editing su fixture, approvazione, diff, recovery e backup/restore solo su dati sacrificabili — [coding](#coding-e-sicurezza).
- [ ] LSP, debugger e eval su progetto di prova — [coding](#coding-e-sicurezza).
- [ ] `web_research` Brave/Perplexity solo con consenso ai costi; SearXNG esplicito con query pubblica — [ricerca](#ricerca-web).
- [ ] Second Brain: health, salvataggio, ricerca, nuova sessione, pertinenza e persistenza — [memoria](#second-brain).
- [ ] SearXNG e OmniRoute: distinguere route, endpoint, identità, auth e inferenza; non attivare autostart — [servizi](#servizi-opzionali).
- [ ] Sicurezza/portabilità: Linux sandbox e gate Windows solo nelle rispettive procedure native — [portabilità](#portabilità).
