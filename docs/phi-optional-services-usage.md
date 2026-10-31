# Usare i servizi opzionali nell'installazione corrente

Questa guida distingue la CLI stabile dal candidato del worktree. Non avvia container, non cambia il modello predefinito e non autorizza inferenza OmniRoute. Stato e receipt: [progress](phi-progress.md) e [continuation](../harness/CONTINUATION.md).

## SearXNG: ricerca esplicita

Nel terminale Fish:

```fish
phi
```

Nella REPL, chiedere: `Usa il tool web_research con query="documentazione Python dataclass", provider="searxng", max_results=3. Non usare Brave o Perplexity come fallback. Mostra provider selezionato e fonti.`

`web_research` è un **tool**, non uno slash command; `provider=searxng` è un parametro esplicito, non il default. La richiesta passa dal modello selezionato e può consumare token, ma non chiama Brave/Perplexity quando l'override è esplicito. Verificare nei dettagli `requested_provider=searxng`, `selected_provider=searxng`, `fallback_used=false` e i risultati normalizzati. I testi delle pagine restano non attendibili. Se SearXNG è fermo o non risponde, la route fallisce con errore/timeout bounded: **non** avvia automaticamente Docker e non passa silenziosamente a un provider diverso. Il percorso reale della route e un precedente smoke della CLI stabile sono registrati nel ledger; lo stato attuale del container deve essere verificato separatamente. Codice: [`extensions/web-policy.ts`](../extensions/web-policy.ts), [`lib/web-routing.mjs`](../lib/web-routing.mjs).

## OmniRoute: catalogo e selezione senza inferenza

Nel terminale Fish:

```fish
phi
```

Nella REPL:

```text
/models --capabilities --provider omniroute
/model
```

`/models --capabilities --provider omniroute` consulta il registro locale; non prova che il catalogo live sia ancora disponibile. `/model` apre il selettore Pi: filtrare `omniroute` e scegliere un modello (per esempio `auto/best-coding` sotto il provider OmniRoute). Annotare prima il modello precedente; per tornare indietro usare di nuovo `/model` e riselezionarlo. La precedente prova Phi/Pi RPC ha verificato selezione e ritorno senza messaggi né inferenza; non dimostra una completion reale. Non inviare un prompt a OmniRoute senza consenso alla relativa inferenza/costo. La CLI stabile non avvia OmniRoute: `config/optional-services.json` è `deferred`. L'endpoint HTTPS atteso è `https://127.0.0.1:20129`, ma la sola presenza dei modelli locali non attesta TLS, Bearer, firewall o salute attuale. [`extensions/omniroute.ts`](../extensions/omniroute.ts) e [`lib/omniroute-tls.mjs`](../lib/omniroute-tls.mjs) definiscono il trasporto.

## Second Brain e startup

Su Linux la preparazione automatica avviene solo all'apertura di una REPL `phi` interattiva con entrambe le TTY, configurazione attendibile e tre unità utente installate. Il manager verifica i tre endpoint, riusa i servizi sani e tenta uno start bounded solo dopo uno stato inattivo/non sano riconosciuto. Un timeout o errore indeterminato non autorizza più lo start nel candidato; gli altri servizi restano indipendenti. `phi doctor --json` mostra prerequisiti ma non sostituisce una prova di scrittura/recupero. OpenViking, Hindsight e embeddings risultavano `loaded/inactive` alla verifica read-only di questo checkpoint; non sono stati avviati per la documentazione. [Guida Second Brain](second-brain.md).

## Installazione e limiti

[`bootstrap/linux.sh`](../bootstrap/linux.sh) installa solo il **foundation wrapper** Phi; [`scripts/bootstrap.sh`](../scripts/bootstrap.sh) prepara Pi Overdrive e dipendenze con backup, pin e opzioni esplicite. Non sono un unico installer atomico dell'intero prodotto. `scripts/bootstrap.sh --check-only` ora verifica il vault senza crearlo. I test isolati provano bootstrap Pi Overdrive in home temporanea e foundation/doctor/wrapper; non certificano upgrade, interruzione a metà transazione, mancanza di spazio, restore completo della CLI o Windows nativo. Per restore usare [operations](operations.md) e i controlli di [backup](../lib/phi-backup.mjs); mai applicarlo a dati reali soltanto per un test.

Il codice modificato in questo worktree **non** è stato promosso al target stabile. La route SearXNG e la selezione OmniRoute già presenti nel target stabile sono storicamente verificate, ma il nuovo `phi doctor` che evita la vecchia sonda HTTP OmniRoute è soltanto nel candidato fino a una release autorizzata.
