# Localizador Inteligente de Boletos x XMLs de NF-e

Sistema rápido e prático para localizar qual nota fiscal (ou parcela/duplicata de nota) corresponde a um boleto recebido, mesmo quando:
1. **O boleto é de apenas uma parcela** (e a nota tem o valor total maior).
2. **O beneficiário do boleto é diferente do emitente da nota** (casos comuns de factoring, banco, faturamento centralizado ou securitizadora).
3. **Você tem centenas de XMLs** (lotes de 600 ou mais notas lidos em menos de 1 segundo diretamente no navegador).

---

## 🚀 Como Iniciar

Basta dar **duplo clique no arquivo**:
```text
iniciar_sistema.bat
```
Ou, se preferir, abra diretamente o arquivo `index.html` em qualquer navegador (Google Chrome, Microsoft Edge, Firefox, etc.).

---

## 🛠️ Como Funciona o Sistema

### 1. Carregamento em Massa dos XMLs
- Clique em **"📁 Selecionar Pasta"** e aponte para a pasta onde estão os seus 600 XMLs (ou arraste a pasta para a área pontilhada).
- O sistema processa os arquivos de forma instantânea (sem enviar nada para a internet, tudo fica 100% seguro e local na sua máquina).
- As notas ficam salvas na memória local do navegador (**IndexedDB**), o que significa que você não precisa recarregar os 600 arquivos toda vez que abrir o sistema!

### 2. Localização do Boleto
Você tem 2 formas super fáceis de achar a nota:

#### Modo Rápido (Linha Digitável / Código de Barras):
- Basta colar a linha digitável do boleto (os 47 números).
- O sistema decodifica na hora o **valor exato** e a **data de vencimento**.

#### Modo Manual:
- **Valor a Pagar (R$)**: Informe o valor do boleto (ex: `167,76`).
- **Tolerância**: Permite buscar valores com pequenas variações de centavos (ex: juros ou descontos).
- **Vencimento do Boleto**: Se preenchido, cruza com o vencimento registrado em `<cobr><dup><dVenc>` da nota.
- **Fornecedor / Beneficiário**: Opcional. Se preenchido, ajuda a ranquear, mas se deixar em branco o sistema busca por valor e vencimento mesmo que o cedente seja outro.
- **Onde buscar**: Escolha entre buscar no valor total da NF, apenas nas duplicatas ou em ambos.

### 3. Resultados com Inteligência de Pontuação (Score)
O sistema ranqueia as notas encontradas destacando:
- 🎯 **Valor Total Coincide**: quando o boleto é no valor integral da nota.
- 💳 **Parcela X Coincide**: quando o boleto refere-se a uma duplicata específica (ex: Parcela 1 de 2, no valor de R$ 167,76 e vencimento em 20/11/2026).
- 📋 **Copiar Chave**: copia a chave de 44 dígitos da NF-e com 1 clique para colar no seu ERP/sistema.
- 🔍 **Visualizar DANFE**: abre uma visualização simplificada da nota com dados do emitente, destinatário, duplicatas, lista de produtos e informações adicionais (`infCpl`).
- 💾 **Baixar XML**: baixa o arquivo XML individual da nota selecionada.

