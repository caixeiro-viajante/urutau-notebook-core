# Núcleo documental Urutau

Worker separado do site, com D1, R2 privado e fila próprios. O site envia a identidade derivada de sua sessão assinada por uma Service Binding; o núcleo não tem rota pública, workers.dev ou URLs de preview.

## Fluxo

1. Preservar os bytes do original, verificar SHA-256 e registrar sua propriedade.
2. Congelar a folha, os objetos estruturados e as referências em uma contribuição idempotente.
3. Entregar JSON-LD, grafo privado e delta `cura/semantic-delta@1` compatível com a lousa.
4. Enfileirar organização ou extração no Google AI, sem substituir a fonte. A transcrição exige conferência antes de virar folha de leitura.

O escopo de trilha ainda pertence ao autor. O destino global é uma proposta privada, sem autoridade para publicar no grafo global. Relações sugeridas pelo modelo são consultivas e separadas do texto original.

## Desenvolvimento

Node 22.13+ e npm. Execute `npm install`, `npm test` e `npm run check`. O teste usa SQLite em memória, R2/fila simulados e uma resposta de provedor simulada; não chama modelos pagos. Gere os tipos novamente depois de mudar os bindings.

Configure `GEMINI_API_KEY` como secret do Worker (`wrangler secret put GEMINI_API_KEY`), nunca no navegador ou no repositório. Sem esse secret, os originais continuam preservados e o trabalho fica em `needs_credentials`, com retomada explícita. As credenciais existentes devem ser reutilizadas apenas no destino autorizado.

Aplique `migrations/0001_core.sql` ao D1 dedicado antes de publicar o Worker. O limite diário padrão é de 20 tentativas por participante e o consumidor trabalha com concorrência 1. Uma tentativa interrompida após despacho não é cobrada de novo automaticamente.

## Open Notebook

Este diretório implementa a adaptação documental para a infraestrutura Cloudflare existente, no fork `caixeiro-viajante/urutau-notebook-core`. O histórico e a licença MIT do upstream `lfnovo/open-notebook` são preservados. O aplicativo Python do Open Notebook não é executado dentro do site nem deste Worker. Nenhuma dependência de execução do Open Notebook foi acrescentada ao site.
