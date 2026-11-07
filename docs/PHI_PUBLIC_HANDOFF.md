# Φ Phi harness-INCOMPLETE — storia e guida alla continuazione

Questo documento è il punto d'ingresso pubblico per chi vuole continuare Phi. Riassume gli ordini del proprietario, le decisioni, le prove e i limiti fino al 7 novembre 2026. Non sostituisce i ledger: per lo stato di ciascun gate usare anzitutto [`harness/MASTER_COMPLETION_MATRIX.md`](../harness/MASTER_COMPLETION_MATRIX.md), poi [`harness/CONTINUATION.md`](../harness/CONTINUATION.md), [`docs/phi-progress.md`](phi-progress.md), [`harness/DECISIONS.md`](../harness/DECISIONS.md) e [`harness/TEST_BASELINE.md`](../harness/TEST_BASELINE.md). Un PASS storico non attesta automaticamente l'host o il candidato di oggi.

## Prodotto e istruzioni del proprietario

Phi è un coding agent basato su Pi: routing dei modelli, strumenti governati, memoria opzionale, ricerca web e installer Linux versionato. L'ordine ricorrente è *FAST DEFAULT*: implementare prima dei report quando il lavoro locale è autorizzato, riusare i componenti esistenti, validare proporzionalmente, preservare lo stato utente e distinguere PASS, FAIL e UNKNOWN. Non indebolire sandbox, autenticazione, policy, ricevute o verifiche d'identità per far passare un test. Distinguere sempre fixture offline, prova Linux locale, host reale e produzione.

Altri confini ripetuti: niente inferenze a pagamento senza consenso, modifiche privilegiate a Docker/firewall solo con autorizzazione specifica, nessuna promozione implicita della CLI stabile, nessuna pubblicazione di credenziali, log, cache o configurazioni private. L'autorizzazione a rendere pubblico questo repository non è autorizzazione ad attivare il candidato sul computer dell'utente.

## Cronologia degli ordini e dei risultati

1. **Fondazione e sicurezza (settembre 2026).** Importazione della base Pi Overdrive; workflow di coding, routing, web research, LSP/debug, governor, isolamento e prove Linux. Decisioni e risultati puntuali sono nei ledger, con data e commit.
2. **Servizi opzionali (ottobre).** L'utente ha chiesto di integrare, non duplicare, i sottosistemi. SearXNG è diventato route esplicita del vero `web_research`; configurazione host protetta, candidato Docker e ricerca JSON reale sono stati provati nei rispettivi checkpoint. Second Brain usa il manager esistente con OpenViking e Hindsight, startup fail-soft e prove storiche di recupero fra sessioni. OmniRoute è passato da un esperimento di namespace differito a un candidato Docker con Caddy, TLS, Bearer/API key e policy egress: checkpoint host hanno riportato HTTPS, catalogo e selezione candidata, ma nessuna inferenza. Resta **manual-only/opt-in**; non sostituire il modello predefinito o aggiungere autostart senza un nuovo gate.
3. **Installer e release Linux (fine ottobre).** Sul percorso esistente è stato costruito un runtime versionato con staging, manifest, attivazione e rollback limitato al runtime. Le prove Linux hanno coperto installazione, A→B→A, errori, recovery di processo e rehearsal isolata. Vera perdita di alimentazione non verificata; Windows nativo non certificato. Target stabile e worktree candidato sono separati.
4. **Esperienza quotidiana e coding (fine ottobre–novembre).** Lavoro su UI/tema, startup, FFF, selezione provider, backup portabile, edit transazionale, fault injection di verifica/ricevute, memoria e Worker. Esistono test mirati e Pi RPC candidato; la presenza del codice da sola non certifica qualità semantica o autonomia.
5. **Pi e sicurezza release (novembre).** Candidato Pi 1.5.0 / pi-subagents 0.84.0, con compatibilità mirata provata. Il bundle Pi distribuito incorpora Undici 8.12.3, interessato da sei advisory; serve un tarball ufficiale con byte eseguibili corretti e nuova verifica. Non usare override npm o patch del bundle come scorciatoia. **Release bloccata** indipendentemente dai progressi funzionali.
6. **Master Completion (novembre).** La matrice separa presenza, integrazione, attivazione, invocabilità, enforcement e prova in produzione. B2 Memory UX è completo per il contratto candidato; B3 ACE prova offline l'ordinamento correzione→fallimento, non l'obbedienza del modello. G1 ha prove Pi RPC di registrazione/selezione e diniego governato nel Worker. G2 ha corretto la scelta di un workflow interrotto obsoleto dopo un run più recente. G3 non ha un confronto diretto equivalente che dimostri beneficio della delega. Tutti e tre i gate G rimangono **PARTIAL** nei limiti indicati nella matrice.

Questa è una storia operativa degli ordini, non la copia integrale della chat: gli ordini originali includevano anche percorsi host e dati di esecuzione. Le decisioni riutilizzabili sono nei documenti collegati e nella cronologia Git.

## Stato e lavoro residuo

| Area | Evidenza | Prossimo gate o limite |
| --- | --- | --- |
| SearXNG | Route esplicita e ricerca reale storicamente provate | Niente autostart implicito né mutazioni del container host per test candidato |
| Second Brain | Manager esistente e prova storica cross-session | Stato host attuale non derivabile dalla prova storica |
| OmniRoute | Candidato Docker/TLS/catalogo e selezione Pi nei checkpoint | Manual-only; nessuna inferenza o attivazione stabile implicita |
| Installer Linux | Attivazione/rollback e rehearsal isolata | Power-loss `NOT_VERIFIED`; Windows nativo `UNKNOWN` |
| G1 Worker | Tool condizionali registrati/selezionati e dinieghi effettivi | Eval delegato positivo non autorizzato dal contratto Worker esercitato; non ampliare authority per ottenere PASS |
| G2 Recovery | Replay obsoleto corretto; single-run coperto | Retirement persistente dei task background e cleanup dopo morte del parent non dimostrati |
| G3 Subagenti | Fixture di delega deterministica disponibile | Manca confronto matched solo/delegato per correttezza, token, latenza e recovery |
| Release | Pi 1.5.0/subagents 0.84.0 candidato | `RELEASE_BLOCKED`: Undici incorporato; attendere artefatto ufficiale verificabile |

Il diniego `PHI_WORKER_TOOL_DENIED` osservato in G1 è enforcement, non un bug da aggirare. Il bug G2 precedente è stato corretto in `9b40668`; l'ultimo checkpoint prima di questo documento è `98ee4a4`. Questi SHA sono riferimenti storici: controllare sempre HEAD e `git status`.

## Mappa e metodo di lavoro

- [`AGENTS.md`](../AGENTS.md): istruzioni e vincoli.
- [`harness/MASTER_COMPLETION_MATRIX.md`](../harness/MASTER_COMPLETION_MATRIX.md): backlog prioritario e prove per ID.
- [`harness/DECISIONS.md`](../harness/DECISIONS.md): autorità e scelte storiche.
- [`harness/CONTINUATION.md`](../harness/CONTINUATION.md), [`docs/phi-progress.md`](phi-progress.md): checkpoint cronologici.
- [`harness/TEST_BASELINE.md`](../harness/TEST_BASELINE.md), [`harness/KNOWN_LIMITATIONS.md`](../harness/KNOWN_LIMITATIONS.md): baseline e limiti, sempre datati.
- [`extensions/`](../extensions/), [`lib/`](../lib/), [`runtime/`](../runtime/): integrazioni Pi, policy e servizi; [`tests/`](../tests/) e [`scripts/`](../scripts/) ospitano prove e procedure.

Per riprendere: leggere istruzioni, matrice e checkpoint; controllare branch, HEAD, index, working tree e untracked senza sovrascrivere lavoro. Scegliere un gap già autorizzato, riprodurlo con fixture disposable o Pi RPC candidato, correggere solo bug reali, eseguire regressioni mirate e aggiornare la matrice con risultati e UNKNOWN. I mock non equivalgono a prove host; non ripetere suite già valide sugli stessi byte. Per G1 distinguere tool registrato, selezionato, invocato e permesso; per G2 evitare doppia esecuzione; per G3 confrontare stesso task e budget.

La release si riapre solo con nuovo tarball Pi ufficiale: integrità, Undici effettivo nelle dipendenze **e nel bundle**, advisory, pin esatti, Doctor/RPC/startup, policy OmniRoute, Worker/subagenti realmente attivi e regressioni Linux. Windows e power-loss restano gate separati. Nessuna promozione stabile senza autorizzazione.

## Privacy della pubblicazione

Log, dipendenze installate e cache non sono sorgenti. Non aggiungere `logs/`, `node_modules/`, `__pycache__/`, file `.env`, credenziali, receipt privati o configurazioni dell'host. Le fixture possono contenere token fittizi: verificarli prima di riutilizzarli. Una scansione automatica non prova l'assenza assoluta di segreti: controllare ogni nuovo commit e l'intera storia raggiungibile prima di cambiare visibilità su GitHub. Una credenziale reale trovata nella storia richiede bonifica e rotazione concordate prima della pubblicazione.
