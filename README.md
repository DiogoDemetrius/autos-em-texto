# Autos em texto

Converte PDFs e imagens de documentos (JPG, PNG, WEBP) em arquivos `.txt`, direto no navegador. O objetivo é mandar texto puro para assistentes de IA em vez de páginas escaneadas, o que consome muito menos do limite de uso.

## Como funciona

- **PDF com texto embutido:** o texto é extraído direto, página por página (pdf.js).
- **PDF escaneado ou imagem:** a página é renderizada e lida por OCR em português (Tesseract.js).
- Páginas com OCR de baixa confiança (abaixo de 60%) são marcadas no arquivo e na tela para conferência.
- Linhas ilegíveis (carimbos, assinaturas, manchas, bordas) são trocadas por `[trecho ilegível]`, e sujeira solta (furos de arquivo, `|`) é descartada.
- Palavras com leitura duvidosa saem marcadas como `[palavra?]`. Também é marcado o ordinal masculino antes de palavra feminina (ex.: `[3º?] Vara`), erro comum em que o OCR troca `ª` por `º` com alta confiança. A marcação pode ser desligada na tela.
- Saída: um `.txt` por arquivo, tudo num `.txt` só, ou um `.zip`.
- Mostra uma estimativa de tokens antes (como imagem) e depois (como texto).

## Privacidade

Os arquivos **não são enviados para nenhum servidor**. Todo o processamento acontece no navegador de quem usa o site. Na primeira visita são baixadas apenas as bibliotecas (cdnjs/jsDelivr) e o modelo de idioma do OCR, que ficam em cache.

## Publicar na Vercel

É um site estático, sem build.

1. Suba esta pasta para um repositório no GitHub.
2. Na Vercel: **Add New → Project**, importe o repositório.
3. Framework Preset: **Other**. Deixe Build Command e Output Directory em branco.
4. Deploy.

Também funciona com a CLI: `npx vercel` dentro da pasta.

## Rodar localmente

```bash
npx serve .
```

Abrir direto o `index.html` pelo explorador de arquivos pode bloquear os workers do OCR; use um servidor local.

## Limitações

- Manuscritos, carimbos e páginas manchadas reduzem bastante a precisão do OCR.
- PDFs protegidos por senha precisam ser desbloqueados antes.
- PDFs muito grandes (centenas de páginas escaneadas) podem demorar alguns minutos; use o campo "Páginas do PDF" para converter por partes.
- TIFF não é suportado pelo navegador; converta para PNG ou PDF antes.
