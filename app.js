// ==========================================================================
// Localizador Inteligente de Boletos x XMLs de NF-e
// ==========================================================================

// Estado da aplicação
const state = {
  db: null,
  notas: [], // Array de objetos com as notas indexadas
  filtros: {
    prioridade: 'relevancia', // 'relevancia', 'vencimento', 'valor', 'valor_vencimento', 'numero_nf', 'fornecedor'
    valor: null,
    tolerancia: 0.00,
    vencimento: '',
    dataDoc: '',
    seuNumero: '',
    fornecedor: '',
    destinatario: '',
    modoBusca: 'ambos' // 'ambos', 'duplicatas', 'total'
  }
};

// --------------------------------------------------------------------------
// 1. Inicialização do Banco IndexedDB Local (Persistência no Navegador)
// --------------------------------------------------------------------------
function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('AcharBoletoNFeDB', 1);

    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('xml_notas')) {
        db.createObjectStore('xml_notas', { keyPath: 'chave' });
      }
    };

    request.onsuccess = (e) => {
      state.db = e.target.result;
      carregarNotasDoDB().then(resolve);
    };

    request.onerror = (e) => {
      console.error('Erro ao abrir IndexedDB:', e);
      resolve();
    };
  });
}

function salvarNotasNoDB(novasNotas) {
  if (!state.db) return Promise.resolve();
  return new Promise((resolve) => {
    const tx = state.db.transaction('xml_notas', 'readwrite');
    const store = tx.objectStore('xml_notas');
    novasNotas.forEach(nota => store.put(nota));
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

function limparDB() {
  if (!state.db) return Promise.resolve();
  return new Promise((resolve) => {
    const tx = state.db.transaction('xml_notas', 'readwrite');
    const store = tx.objectStore('xml_notas');
    store.clear();
    tx.oncomplete = () => {
      state.notas = [];
      atualizarContadorNotas();
      executarBusca();
      resolve();
    };
  });
}

function carregarNotasDoDB() {
  if (!state.db) return Promise.resolve();
  return new Promise((resolve) => {
    const tx = state.db.transaction('xml_notas', 'readonly');
    const store = tx.objectStore('xml_notas');
    const req = store.getAll();
    req.onsuccess = () => {
      state.notas = req.result || [];
      atualizarContadorNotas();
      resolve();
    };
    req.onerror = () => resolve();
  });
}

// --------------------------------------------------------------------------
// 2. Parser de XML de NF-e (Leitura nativa e robusta com/sem namespaces)
// --------------------------------------------------------------------------
function getTagText(element, tagName) {
  if (!element) return '';
  const node = element.getElementsByTagName(tagName)[0];
  return node && node.textContent ? node.textContent.trim() : '';
}

function parseXmlNFe(xmlString, filename = 'nota.xml') {
  try {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlString, 'application/xml');

    // Valida se houve erro de parse
    const parserError = xmlDoc.getElementsByTagName('parsererror');
    if (parserError.length > 0) return null;

    const infNFe = xmlDoc.getElementsByTagName('infNFe')[0];
    if (!infNFe) return null;

    let chave = infNFe.getAttribute('Id') || '';
    chave = chave.replace(/^NFe/, '');

    // Se não achou no Id, procura na tag chNFe do protNFe
    if (!chave) {
      chave = getTagText(xmlDoc, 'chNFe');
    }
    if (!chave) {
      chave = 'chave_' + Math.random().toString(36).substring(2, 12);
    }

    // Identificação da Nota
    const ide = xmlDoc.getElementsByTagName('ide')[0];
    const nNF = getTagText(ide, 'nNF');
    const serie = getTagText(ide, 'serie');
    const dhEmiRaw = getTagText(ide, 'dhEmi') || getTagText(ide, 'dEmi');
    const dhEmi = dhEmiRaw ? dhEmiRaw.split('T')[0] : '';

    // Emitente (Fornecedor)
    const emit = xmlDoc.getElementsByTagName('emit')[0];
    const emitCNPJ = getTagText(emit, 'CNPJ') || getTagText(emit, 'CPF');
    const emitNome = getTagText(emit, 'xNome');
    const emitFant = getTagText(emit, 'xFant');
    const emitUF = getTagText(emit, 'UF');
    const emitMun = getTagText(emit, 'xMun');

    // Destinatário
    const dest = xmlDoc.getElementsByTagName('dest')[0];
    const destCNPJ = getTagText(dest, 'CNPJ') || getTagText(dest, 'CPF');
    const destNome = getTagText(dest, 'xNome');

    // Totais
    const total = xmlDoc.getElementsByTagName('total')[0];
    const vNFStr = getTagText(total, 'vNF');
    const vNF = parseFloat(vNFStr) || 0.0;

    // Duplicatas / Parcelas de Cobrança
    const duplicatas = [];
    const dupNodes = xmlDoc.getElementsByTagName('dup');
    for (let i = 0; i < dupNodes.length; i++) {
      const d = dupNodes[i];
      const nDup = getTagText(d, 'nDup') || `${i + 1}`;
      const dVenc = getTagText(d, 'dVenc');
      const vDup = parseFloat(getTagText(d, 'vDup')) || 0.0;
      duplicatas.push({ nDup, dVenc, vDup });
    }

    // Informações Adicionais
    const infCpl = getTagText(xmlDoc, 'infCpl');

    // Itens da Nota
    const produtos = [];
    const detNodes = xmlDoc.getElementsByTagName('det');
    for (let i = 0; i < detNodes.length; i++) {
      const prod = detNodes[i].getElementsByTagName('prod')[0];
      if (prod) {
        produtos.push({
          item: i + 1,
          cProd: getTagText(prod, 'cProd'),
          xProd: getTagText(prod, 'xProd'),
          qCom: parseFloat(getTagText(prod, 'qCom')) || 0,
          vUnCom: parseFloat(getTagText(prod, 'vUnCom')) || 0,
          vProd: parseFloat(getTagText(prod, 'vProd')) || 0
        });
      }
    }

    return {
      chave,
      nNF,
      serie,
      dhEmi,
      emitente: {
        cnpj: emitCNPJ,
        nome: emitNome,
        fantasia: emitFant,
        cidade: emitMun,
        uf: emitUF
      },
      destinatario: {
        cnpj: destCNPJ,
        nome: destNome
      },
      vNF,
      duplicatas,
      infCpl,
      produtos,
      filename,
      rawXml: xmlString
    };
  } catch (err) {
    console.error('Falha ao processar XML:', err);
    return null;
  }
}

// --------------------------------------------------------------------------
// 3. Processamento de Arquivos e Pastas em Massa
// --------------------------------------------------------------------------
async function processarArquivosXML(files) {
  const xmlFiles = Array.from(files).filter(f => f.name.toLowerCase().endsWith('.xml'));
  if (xmlFiles.length === 0) {
    mostrarToast('Nenhum arquivo .xml foi encontrado na seleção.', 'warning');
    return;
  }

  const inicio = performance.now();
  mostrarToast(`Carregando e indexando ${xmlFiles.length} arquivos XML...`, 'info');

  const novasNotas = [];
  const erros = 0;

  for (let i = 0; i < xmlFiles.length; i++) {
    const file = xmlFiles[i];
    try {
      const text = await file.text();
      const nota = parseXmlNFe(text, file.name);
      if (nota) {
        novasNotas.push(nota);
      }
    } catch (e) {
      console.warn('Erro ao ler arquivo', file.name, e);
    }
  }

  // Mescla com as notas já existentes evitando duplicar mesma chave
  const mapa = new Map();
  state.notas.forEach(n => mapa.set(n.chave, n));
  novasNotas.forEach(n => mapa.set(n.chave, n));

  state.notas = Array.from(mapa.values());
  await salvarNotasNoDB(state.notas);

  const tempo = ((performance.now() - inicio) / 1000).toFixed(2);
  atualizarContadorNotas();
  mostrarToast(`${novasNotas.length} XMLs lidos em ${tempo}s com sucesso!`, 'success');
  executarBusca();
}

function atualizarContadorNotas() {
  const totalNotas = state.notas.length;
  let totalDuplicatas = 0;
  state.notas.forEach(n => totalDuplicatas += (n.duplicatas ? n.duplicatas.length : 0));

  const elContador = document.getElementById('contador-notas');
  if (elContador) {
    elContador.textContent = `${totalNotas} ${totalNotas === 1 ? 'Nota' : 'Notas'} (${totalDuplicatas} parcelas)`;
  }

  atualizarOpcoesDestinatarios();
}

function atualizarOpcoesDestinatarios() {
  const select = document.getElementById('filtro-destinatario');
  if (!select) return;

  const valorAtual = select.value;
  const mapa = new Map();

  state.notas.forEach(n => {
    if (n.destinatario && n.destinatario.cnpj) {
      const chave = n.destinatario.cnpj.replace(/\D/g, '');
      if (!mapa.has(chave)) {
        mapa.set(chave, n.destinatario.nome || formatarCNPJ(n.destinatario.cnpj));
      }
    }
  });

  let html = '<option value="">Todas as empresas / filiais</option>';
  mapa.forEach((nome, cnpj) => {
    const selected = cnpj === valorAtual ? 'selected' : '';
    html += `<option value="${cnpj}" ${selected}>${nome} (${formatarCNPJ(cnpj)})</option>`;
  });

  select.innerHTML = html;
}

// --------------------------------------------------------------------------
// 4. Decodificador de Linha Digitável de Boleto Bancário
// --------------------------------------------------------------------------
function decodificarLinhaDigitavel(linha) {
  // Limpa caracteres especiais
  const digitos = linha.replace(/\D/g, '');

  // Boleto Bancário Padrão tem 47 dígitos
  if (digitos.length === 47) {
    // Campo 5 (posições 34 a 47):
    // Posições 34 a 37 (4 dígitos): Fator de Vencimento
    // Posições 38 a 47 (10 dígitos): Valor nominal (em centavos)
    const fatorVencStr = digitos.substring(33, 37);
    const valorStr = digitos.substring(37, 47);

    const valor = parseInt(valorStr, 10) / 100;
    const fator = parseInt(fatorVencStr, 10);

    let dataVencimento = '';
    if (fator > 0) {
      // Regra FEBRABAN de Fator de Vencimento
      // Base antiga: 07/10/1997 com fator 1000 em 03/07/2000
      // A virada ocorreu em 22/02/2025 para novo ciclo
      // Implementação compatível:
      let dataBase = new Date(1997, 9, 7); // 07/10/1997
      let dias = fator;
      
      // Se fator está no novo ciclo pós 2025:
      const hoje = new Date();
      if (hoje.getFullYear() >= 2025 && fator < 3000) {
        // Segundo ciclo FEBRABAN: fator 1000 foi 22/02/2025
        dataBase = new Date(2025, 1, 22);
        dias = fator - 1000;
      }
      
      const venc = new Date(dataBase.getTime() + (dias * 24 * 60 * 60 * 1000));
      dataVencimento = venc.toISOString().split('T')[0];
    }

    return {
      sucesso: true,
      valor,
      dataVencimento,
      fator,
      tipo: 'Boleto Bancário (47 dígitos)'
    };
  }

  // Código de barras direto (44 dígitos)
  if (digitos.length === 44) {
    const fatorVencStr = digitos.substring(5, 9);
    const valorStr = digitos.substring(9, 19);
    const valor = parseInt(valorStr, 10) / 100;
    const fator = parseInt(fatorVencStr, 10);

    let dataVencimento = '';
    if (fator > 0) {
      const dataBase = new Date(1997, 9, 7);
      const venc = new Date(dataBase.getTime() + (fator * 24 * 60 * 60 * 1000));
      dataVencimento = venc.toISOString().split('T')[0];
    }

    return {
      sucesso: true,
      valor,
      dataVencimento,
      fator,
      tipo: 'Código de Barras (44 dígitos)'
    };
  }

  return { sucesso: false };
}

// --------------------------------------------------------------------------
// 5. Algoritmo de Busca, Comparação e Pontuação de Relevância (Scoring)
// --------------------------------------------------------------------------
function normalizarTexto(txt) {
  if (!txt) return '';
  return txt.toString().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatarMoeda(val) {
  return (val || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatarDataBR(dataIso) {
  if (!dataIso) return '-';
  const partes = dataIso.split('-');
  if (partes.length === 3) {
    return `${partes[2]}/${partes[1]}/${partes[0]}`;
  }
  return dataIso;
}

function calcularDiferencaDias(dataIso1, dataIso2) {
  if (!dataIso1 || !dataIso2) return 999;
  const d1 = new Date(dataIso1);
  const d2 = new Date(dataIso2);
  const diffTime = Math.abs(d2 - d1);
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

function executarBusca() {
  const container = document.getElementById('lista-resultados');
  const resumo = document.getElementById('resumo-resultados');

  if (state.notas.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📂</div>
        <h3>Nenhuma nota fiscal carregada ainda</h3>
        <p>Clique em "Selecionar Pasta de XMLs" ou no botão "Carregar Notas de Teste" ao lado para carregar os XMLs e iniciar a busca.</p>
      </div>
    `;
    resumo.textContent = 'Aguardando arquivos XML...';
    return;
  }

  const { prioridade, valor, tolerancia, vencimento, dataDoc, seuNumero, fornecedor, destinatario, modoBusca } = state.filtros;

  // Validações se o usuário selecionou uma prioridade estrita mas não preencheu o campo
  if (prioridade === 'vencimento' && !vencimento) {
    resumo.textContent = '⚠️ Selecione uma Data de Vencimento ao lado para aplicar a prioridade';
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📅</div>
        <h3>Informe a Data de Vencimento</h3>
        <p>Você escolheu "Prioridade: VENCIMENTO". Selecione uma data no campo "Data do Vencimento" para exibir <strong>apenas</strong> as notas/parcelas daquele dia.</p>
      </div>
    `;
    return;
  }

  if (prioridade === 'valor' && (valor === null || isNaN(valor))) {
    resumo.textContent = '⚠️ Digite um Valor ao lado para aplicar a prioridade';
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">💰</div>
        <h3>Informe o Valor do Documento</h3>
        <p>Você escolheu "Prioridade: VALOR". Digite o valor do boleto para exibir <strong>apenas</strong> as notas/parcelas com esse valor.</p>
      </div>
    `;
    return;
  }

  if (prioridade === 'valor_vencimento' && ((valor === null || isNaN(valor)) || !vencimento)) {
    resumo.textContent = '⚠️ Preencha Valor E Vencimento ao lado';
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🔒</div>
        <h3>Informe Valor e Vencimento</h3>
        <p>Você escolheu "Prioridade: VALOR + VENCIMENTO". Preencha ambos os campos para exibir apenas notas que batam com os dois ao mesmo tempo.</p>
      </div>
    `;
    return;
  }

  if (prioridade === 'numero_nf' && !seuNumero) {
    resumo.textContent = '⚠️ Digite o número da nota no campo "Seu Número"';
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🔢</div>
        <h3>Informe o Número da NF</h3>
        <p>Você escolheu "Prioridade: SEU NÚMERO". Digite o número da nota fiscal para exibi-la diretamente.</p>
      </div>
    `;
    return;
  }

  // Se nenhum filtro foi digitado e está em modo relevância, exibe todas as notas
  if (prioridade === 'relevancia' && (valor === null || isNaN(valor)) && !vencimento && !dataDoc && !seuNumero && !fornecedor && !destinatario) {
    resumo.textContent = `Mostrando todas as ${state.notas.length} notas carregadas (digite os dados do título/DDA ao lado para buscar)`;
    renderizarCards(state.notas.map(n => ({ nota: n, score: 0, tipoMatch: 'todas' })));
    return;
  }

  const fornecedorNorm = normalizarTexto(fornecedor);
  const seuNumeroLimpo = seuNumero ? seuNumero.replace(/\D/g, '') : '';
  const destinatarioLimpo = destinatario ? destinatario.replace(/\D/g, '') : '';
  const resultados = [];

  for (const nota of state.notas) {
    // 1. Filtro estrito de Destinatário (Filial/Empresa)
    if (destinatarioLimpo) {
      const destCnpjNota = (nota.destinatario && nota.destinatario.cnpj) ? nota.destinatario.cnpj.replace(/\D/g, '') : '';
      if (destCnpjNota !== destinatarioLimpo) {
        continue;
      }
    }

    // 2. Filtro estrito de "Seu Número" (Nº NF) se essa for a prioridade
    if (prioridade === 'numero_nf') {
      const nNFLimpo = (nota.nNF || '').replace(/\D/g, '');
      if (nNFLimpo !== seuNumeroLimpo && parseInt(nNFLimpo, 10) !== parseInt(seuNumeroLimpo, 10)) {
        continue;
      }
    }

    // 3. Filtro estrito de Fornecedor se essa for a prioridade
    if (prioridade === 'fornecedor') {
      const emitNomeNorm = normalizarTexto(nota.emitente.nome);
      const emitFantNorm = normalizarTexto(nota.emitente.fantasia);
      const emitCnpj = (nota.emitente.cnpj || '').replace(/\D/g, '');
      const infCplNorm = normalizarTexto(nota.infCpl);

      const bateu = emitNomeNorm.includes(fornecedorNorm) ||
                    emitFantNorm.includes(fornecedorNorm) ||
                    (emitCnpj && emitCnpj.includes(fornecedor.replace(/\D/g, ''))) ||
                    infCplNorm.includes(fornecedorNorm);

      if (!bateu) continue;
    }

    let melhorScore = 0;
    let tipoMatch = '';
    let detalheMatch = '';
    let duplicataAlvo = null;
    let atendePrioridade = (prioridade === 'relevancia' || prioridade === 'numero_nf' || prioridade === 'fornecedor');

    // Analisa Duplicatas / Parcelas
    if (modoBusca === 'ambos' || modoBusca === 'duplicatas') {
      if (nota.duplicatas && nota.duplicatas.length > 0) {
        for (const dup of nota.duplicatas) {
          let scoreDup = 0;
          let matchValor = false;
          let matchVenc = false;

          // Análise de Valor na Duplicata
          if (valor !== null && !isNaN(valor) && valor > 0) {
            const diffValor = Math.abs(dup.vDup - valor);
            if (diffValor <= 0.001) {
              scoreDup += 55;
              matchValor = true;
            } else if (diffValor <= tolerancia) {
              scoreDup += 45;
              matchValor = true;
            }
          }

          // Análise de Vencimento na Duplicata
          if (vencimento) {
            const diffDias = calcularDiferencaDias(dup.dVenc, vencimento);
            if (diffDias === 0) {
              scoreDup += 35;
              matchVenc = true;
            } else if (diffDias <= 3) {
              scoreDup += 20;
            }
          }

          // Checagem de Prioridade Estrita
          if (prioridade === 'vencimento' && matchVenc) {
            atendePrioridade = true;
          }
          if (prioridade === 'valor' && matchValor) {
            atendePrioridade = true;
          }
          if (prioridade === 'valor_vencimento' && matchValor && matchVenc) {
            atendePrioridade = true;
          }

          if (scoreDup > melhorScore) {
            melhorScore = scoreDup;
            tipoMatch = 'parcela';
            duplicataAlvo = dup;
            detalheMatch = `Parcela ${dup.nDup} (${formatarMoeda(dup.vDup)} - Venc: ${formatarDataBR(dup.dVenc)})`;
          }
        }
      }
    }

    // Analisa Valor Total da Nota
    if (modoBusca === 'ambos' || modoBusca === 'total') {
      let scoreTotal = 0;
      let matchValorTotal = false;
      let matchVencTotal = false;

      if (valor !== null && !isNaN(valor) && valor > 0) {
        const diffValor = Math.abs(nota.vNF - valor);
        if (diffValor <= 0.001) {
          scoreTotal += 55;
          matchValorTotal = true;
        } else if (diffValor <= tolerancia) {
          scoreTotal += 45;
          matchValorTotal = true;
        }
      }

      if (vencimento && nota.duplicatas && nota.duplicatas.length > 0) {
        const diffDias = calcularDiferencaDias(nota.duplicatas[0].dVenc, vencimento);
        if (diffDias === 0) {
          scoreTotal += 35;
          matchVencTotal = true;
        } else if (diffDias <= 3) {
          scoreTotal += 20;
        }
      }

      if (prioridade === 'vencimento' && matchVencTotal) {
        atendePrioridade = true;
      }
      if (prioridade === 'valor' && matchValorTotal) {
        atendePrioridade = true;
      }
      if (prioridade === 'valor_vencimento' && matchValorTotal && matchVencTotal) {
        atendePrioridade = true;
      }

      if (scoreTotal > melhorScore) {
        melhorScore = scoreTotal;
        tipoMatch = 'total';
        duplicataAlvo = null;
        detalheMatch = `Valor Total da Nota (${formatarMoeda(nota.vNF)})`;
      }
    }

    // Se o usuário selecionou uma prioridade estrita (Vencimento, Valor, ou Valor+Vencimento) e a nota NÃO atendeu:
    if (!atendePrioridade) {
      continue; // Pula essa nota! Exibe estritamente o que atende a prioridade!
    }

    // Pontuações complementares (Seu Número, Emissão, Fornecedor)
    if (seuNumeroLimpo) {
      const nNFLimpo = (nota.nNF || '').replace(/\D/g, '');
      if (nNFLimpo && (nNFLimpo === seuNumeroLimpo || parseInt(nNFLimpo, 10) === parseInt(seuNumeroLimpo, 10))) {
        melhorScore += 60;
        if (!tipoMatch) tipoMatch = 'numero_nf';
      }
    }

    if (dataDoc && nota.dhEmi) {
      const diffEmissao = calcularDiferencaDias(nota.dhEmi, dataDoc);
      if (diffEmissao === 0) melhorScore += 15;
      else if (diffEmissao <= 2) melhorScore += 10;
    }

    if (fornecedorNorm) {
      const emitNomeNorm = normalizarTexto(nota.emitente.nome);
      const emitFantNorm = normalizarTexto(nota.emitente.fantasia);
      const emitCnpj = (nota.emitente.cnpj || '').replace(/\D/g, '');
      const infCplNorm = normalizarTexto(nota.infCpl);

      if (emitNomeNorm.includes(fornecedorNorm) || emitFantNorm.includes(fornecedorNorm)) {
        melhorScore += 20;
      } else if (emitCnpj && emitCnpj.includes(fornecedor.replace(/\D/g, ''))) {
        melhorScore += 25;
      } else if (infCplNorm.includes(fornecedorNorm)) {
        melhorScore += 15;
      }
    }

    // Garante score mínimo para exibir notas filtradas por prioridade estrita
    if (atendePrioridade && melhorScore === 0) {
      melhorScore = 75;
    }

    if (melhorScore > 100) melhorScore = 100;

    resultados.push({
      nota,
      score: melhorScore,
      tipoMatch,
      detalheMatch,
      duplicataAlvo
    });
  }

  // Ordena pelo maior score primeiro
  resultados.sort((a, b) => b.score - a.score);

  salvarUltimosResultados(resultados);

  let tituloPrioridade = '';
  if (prioridade === 'vencimento') tituloPrioridade = `com Vencimento em ${formatarDataBR(vencimento)}`;
  else if (prioridade === 'valor') tituloPrioridade = `com Valor de ${formatarMoeda(valor)}`;
  else if (prioridade === 'valor_vencimento') tituloPrioridade = `com Valor ${formatarMoeda(valor)} E Vencimento ${formatarDataBR(vencimento)}`;
  else if (prioridade === 'numero_nf') tituloPrioridade = `com NF nº ${seuNumero}`;
  else if (prioridade === 'fornecedor') tituloPrioridade = `do Fornecedor "${fornecedor}"`;

  resumo.textContent = resultados.length === 1
    ? `1 nota encontrada ${tituloPrioridade}`
    : `${resultados.length} notas encontradas ${tituloPrioridade}`;

  renderizarCards(resultados);
}

// --------------------------------------------------------------------------
// 6. Renderização dos Cards de Resultados
// --------------------------------------------------------------------------
function renderizarCards(resultados) {
  const container = document.getElementById('lista-resultados');

  if (resultados.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🔍</div>
        <h3>Nenhuma nota compatível com os dados informados</h3>
        <p>Tente aumentar a tolerância de valor (ex: ± R$ 0,50 ou R$ 2,00) ou deixe o campo de fornecedor em branco, pois muitos boletos vêm em nome de bancos ou factorings diferentes do emitente.</p>
      </div>
    `;
    return;
  }

  let html = '';

  for (const item of resultados) {
    const { nota, score, tipoMatch, detalheMatch, duplicataAlvo } = item;

    let scoreClass = 'score-100';
    if (score < 50) scoreClass = 'score-med';
    else if (score < 80) scoreClass = 'score-high';

    let cardBorderClass = score >= 80 ? 'perfect-match' : (score >= 40 ? 'partial-match' : '');

    let badgeTipo = '';
    if (tipoMatch === 'parcela' && duplicataAlvo) {
      badgeTipo = `<span class="match-tag tag-parcela">💳 Parcela ${duplicataAlvo.nDup} Identificada</span>`;
    } else if (tipoMatch === 'total') {
      badgeTipo = `<span class="match-tag tag-total">🎯 Valor Total Coincide</span>`;
    }

    // Renderiza duplicatas da nota com destaque na que bateu
    let duplicatasHtml = '';
    if (nota.duplicatas && nota.duplicatas.length > 0) {
      const chips = nota.duplicatas.map(d => {
        const isHit = duplicataAlvo && duplicataAlvo.nDup === d.nDup && Math.abs(duplicataAlvo.vDup - d.vDup) < 0.01;
        return `
          <div class="dup-chip ${isHit ? 'hit' : ''}">
            ${isHit ? '🎯' : '•'} <strong>Parc. ${d.nDup}:</strong> ${formatarMoeda(d.vDup)}
            <span style="color: #64748b;">(Venc: ${formatarDataBR(d.dVenc)})</span>
          </div>
        `;
      }).join('');

      duplicatasHtml = `
        <div class="duplicatas-container">
          <div class="duplicatas-title">
            <span>Parcelas / Duplicatas desta Nota (${nota.duplicatas.length}):</span>
          </div>
          <div class="duplicatas-list">
            ${chips}
          </div>
        </div>
      `;
    }

    html += `
      <div class="match-card ${cardBorderClass}">
        <div class="match-card-top">
          <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
            ${score > 0 ? `<span class="score-badge ${scoreClass}">${score}% Correspondência</span>` : ''}
            ${badgeTipo}
            <span style="font-size: 0.825rem; font-weight: 700; color: #1e293b;">NF-e nº ${nota.nNF} (Série ${nota.serie})</span>
          </div>
          <span style="font-size: 0.8rem; color: #64748b;">Emissão: ${formatarDataBR(nota.dhEmi)}</span>
        </div>

        <div class="match-card-content">
          <div class="info-grid">
            <div class="info-item">
              <div class="info-label">Emitente / Fornecedor</div>
              <div class="info-val">${nota.emitente.nome || 'Não informado'}</div>
              <div style="font-size: 0.775rem; color: #64748b;">CNPJ: ${formatarCNPJ(nota.emitente.cnpj)} ${nota.emitente.fantasia ? `(${nota.emitente.fantasia})` : ''}</div>
            </div>

            <div class="info-item">
              <div class="info-label">Destinatário</div>
              <div class="info-val">${nota.destinatario.nome || 'Não informado'}</div>
              <div style="font-size: 0.775rem; color: #64748b;">CNPJ: ${formatarCNPJ(nota.destinatario.cnpj)}</div>
            </div>

            <div class="info-item">
              <div class="info-label">Valor Total da NF-e</div>
              <div class="info-val" style="color: #2563eb; font-size: 1.1rem;">${formatarMoeda(nota.vNF)}</div>
              ${tipoMatch === 'parcela' && duplicataAlvo ? `<div style="font-size: 0.775rem; color: #16a34a; font-weight: 600;">Boleto bateu com a parcela de ${formatarMoeda(duplicataAlvo.vDup)}</div>` : ''}
            </div>
          </div>

          ${duplicatasHtml}

          ${nota.infCpl ? `
            <div style="margin-top: 0.75rem; font-size: 0.775rem; color: #475569; background: #f8fafc; padding: 0.5rem 0.75rem; border-radius: 6px; border: 1px solid #e2e8f0;">
              <strong>Obs / Informações Adicionais:</strong> ${truncarTexto(nota.infCpl, 180)}
            </div>
          ` : ''}
        </div>

        <div class="match-card-actions">
          <button class="btn btn-secondary btn-sm" onclick="copiarChave('${nota.chave}')">
            📋 Copiar Chave
          </button>
          <button class="btn btn-secondary btn-sm" onclick="abrirModalDanfe('${nota.chave}')">
            🔍 Visualizar DANFE
          </button>
          <button class="btn btn-primary btn-sm" onclick="baixarXml('${nota.chave}')">
            💾 Baixar XML
          </button>
        </div>
      </div>
    `;
  }

  container.innerHTML = html;
}

// --------------------------------------------------------------------------
// 7. Auxiliares de Formatação e Ações do Usuário
// --------------------------------------------------------------------------
function formatarCNPJ(v) {
  if (!v) return '-';
  const c = v.replace(/\D/g, '');
  if (c.length === 14) {
    return c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  }
  if (c.length === 11) {
    return c.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  }
  return v;
}

function truncarTexto(txt, max) {
  if (!txt) return '';
  return txt.length > max ? txt.substring(0, max) + '...' : txt;
}

function copiarChave(chave) {
  navigator.clipboard.writeText(chave).then(() => {
    mostrarToast('Chave de acesso copiada para a área de transferência!', 'success');
  }).catch(() => {
    prompt('Copie a chave de acesso:', chave);
  });
}

function baixarXml(chave) {
  const nota = state.notas.find(n => n.chave === chave);
  if (!nota || !nota.rawXml) return;

  const blob = new Blob([nota.rawXml], { type: 'application/xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `NFe_${nota.nNF || chave}.xml`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function abrirModalDanfe(chave) {
  const nota = state.notas.find(n => n.chave === chave);
  if (!nota) return;

  document.getElementById('modal-titulo').textContent = `Espelho DANFE - NF-e nº ${nota.nNF}`;
  
  let produtosLinhas = '';
  if (nota.produtos && nota.produtos.length > 0) {
    produtosLinhas = nota.produtos.map(p => `
      <tr>
        <td>${p.cProd}</td>
        <td>${p.xProd}</td>
        <td style="text-align: right;">${p.qCom}</td>
        <td style="text-align: right;">${formatarMoeda(p.vUnCom)}</td>
        <td style="text-align: right; font-weight: 600;">${formatarMoeda(p.vProd)}</td>
      </tr>
    `).join('');
  } else {
    produtosLinhas = '<tr><td colspan="5" style="text-align:center; color:#94a3b8;">Itens não detalhados</td></tr>';
  }

  let dupsModal = '';
  if (nota.duplicatas && nota.duplicatas.length > 0) {
    dupsModal = nota.duplicatas.map(d => `
      <div style="background:#f1f5f9; padding: 0.4rem 0.75rem; border-radius: 6px; border: 1px solid #cbd5e1; font-size: 0.8rem;">
        <strong>Parc. ${d.nDup}:</strong> ${formatarMoeda(d.vDup)} - Venc: ${formatarDataBR(d.dVenc)}
      </div>
    `).join('');
  } else {
    dupsModal = '<span style="color:#94a3b8; font-size:0.8rem;">À vista / Sem cobrança a prazo informada</span>';
  }

  const html = `
    <div class="danfe-simples">
      <div style="text-align: center; border-bottom: 2px solid #e2e8f0; padding-bottom: 0.75rem; margin-bottom: 0.75rem;">
        <h2 style="font-size: 1.1rem; color: #1e293b;">DANFE SIMPLIFICADO</h2>
        <div style="font-size: 0.8rem; color: #64748b;">CHAVE DE ACESSO: ${nota.chave}</div>
      </div>

      <div class="danfe-section-title">EMITENTE</div>
      <div style="font-weight: 700; font-size: 0.95rem;">${nota.emitente.nome}</div>
      <div>CNPJ: ${formatarCNPJ(nota.emitente.cnpj)} | Cidade: ${nota.emitente.cidade || ''} - ${nota.emitente.uf || ''}</div>

      <div class="danfe-section-title">DESTINATÁRIO</div>
      <div style="font-weight: 700;">${nota.destinatario.nome}</div>
      <div>CNPJ: ${formatarCNPJ(nota.destinatario.cnpj)}</div>

      <div class="danfe-section-title">DADOS DA NOTA E TOTAIS</div>
      <div style="display: flex; gap: 1.5rem; flex-wrap: wrap;">
        <div><strong>Número:</strong> ${nota.nNF}</div>
        <div><strong>Série:</strong> ${nota.serie}</div>
        <div><strong>Data de Emissão:</strong> ${formatarDataBR(nota.dhEmi)}</div>
        <div><strong>Valor Total:</strong> <span style="font-size: 1.05rem; font-weight: 700; color: #2563eb;">${formatarMoeda(nota.vNF)}</span></div>
      </div>

      <div class="danfe-section-title">DUPLICATAS / PARCELAS</div>
      <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
        ${dupsModal}
      </div>

      <div class="danfe-section-title">PRODUTOS / SERVIÇOS</div>
      <div style="max-height: 180px; overflow-y: auto;">
        <table class="table-produtos">
          <thead>
            <tr>
              <th>Cód</th>
              <th>Descrição</th>
              <th style="text-align: right;">Qtd</th>
              <th style="text-align: right;">Unitário</th>
              <th style="text-align: right;">Total</th>
            </tr>
          </thead>
          <tbody>
            ${produtosLinhas}
          </tbody>
        </table>
      </div>

      <div class="danfe-section-title">INFORMAÇÕES COMPLEMENTARES</div>
      <div class="infcpl-box">${nota.infCpl || 'Nenhuma informação complementar informada.'}</div>
    </div>
  `;

  document.getElementById('modal-corpo').innerHTML = html;
  document.getElementById('modal-danfe').classList.add('open');
}

function fecharModal() {
  document.getElementById('modal-danfe').classList.remove('open');
}

function mostrarToast(msg, tipo = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast';
  
  let icone = 'ℹ️';
  if (tipo === 'success') icone = '✅';
  if (tipo === 'warning') icone = '⚠️';
  if (tipo === 'danger') icone = '❌';

  toast.innerHTML = `<span>${icone}</span> <span>${msg}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 200);
  }, 3500);
}

// --------------------------------------------------------------------------
// 8. Event Listeners e Configuração da Página
// --------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
  await initDB();

  // Inputs
  const selectPrioridade = document.getElementById('filtro-prioridade');
  const inputValor = document.getElementById('filtro-valor');
  const selectTolerancia = document.getElementById('filtro-tolerancia');
  const inputVencimento = document.getElementById('filtro-vencimento');
  const inputDataDoc = document.getElementById('filtro-data-doc');
  const inputSeuNumero = document.getElementById('filtro-seu-numero');
  const inputFornecedor = document.getElementById('filtro-fornecedor');
  const selectDestinatario = document.getElementById('filtro-destinatario');
  const selectModo = document.getElementById('filtro-modo');
  const inputLinhaDigitavel = document.getElementById('filtro-linha-digitavel');

  // Input de arquivos
  const fileInputFolder = document.getElementById('file-input-folder');
  const fileInputMultiple = document.getElementById('file-input-multiple');
  const dropzone = document.getElementById('dropzone');

  // Atualiza filtros manuais
  const atualizarFiltros = () => {
    state.filtros.prioridade = selectPrioridade.value;
    const v = inputValor.value.replace(',', '.').trim();
    state.filtros.valor = v === '' ? null : parseFloat(v);
    state.filtros.tolerancia = parseFloat(selectTolerancia.value) || 0.00;
    state.filtros.vencimento = inputVencimento.value;
    state.filtros.dataDoc = inputDataDoc.value;
    state.filtros.seuNumero = inputSeuNumero.value.trim();
    state.filtros.fornecedor = inputFornecedor.value.trim();
    state.filtros.destinatario = selectDestinatario.value;
    state.filtros.modoBusca = selectModo.value;
    executarBusca();
  };

  selectPrioridade.addEventListener('change', atualizarFiltros);
  inputValor.addEventListener('input', atualizarFiltros);
  selectTolerancia.addEventListener('change', atualizarFiltros);
  inputVencimento.addEventListener('input', atualizarFiltros);
  inputDataDoc.addEventListener('input', atualizarFiltros);
  inputSeuNumero.addEventListener('input', atualizarFiltros);
  inputFornecedor.addEventListener('input', atualizarFiltros);
  selectDestinatario.addEventListener('change', atualizarFiltros);
  selectModo.addEventListener('change', atualizarFiltros);

  // Limpar Busca
  document.getElementById('btn-limpar-busca').addEventListener('click', () => {
    selectPrioridade.value = 'relevancia';
    inputValor.value = '';
    inputVencimento.value = '';
    inputDataDoc.value = '';
    inputSeuNumero.value = '';
    inputFornecedor.value = '';
    selectDestinatario.value = '';
    inputLinhaDigitavel.value = '';
    selectTolerancia.value = '0.00';
    selectModo.value = 'ambos';
    atualizarFiltros();
  });

  // Limpar Base de Dados
  document.getElementById('btn-limpar-base').addEventListener('click', () => {
    if (confirm('Tem certeza que deseja apagar todas as notas carregadas da memória?')) {
      limparDB();
      mostrarToast('Base de notas fiscais limpa.', 'info');
    }
  });

  // Upload por Pasta
  document.getElementById('btn-carregar-pasta').addEventListener('click', () => {
    fileInputFolder.click();
  });
  fileInputFolder.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      processarArquivosXML(e.target.files);
    }
  });

  // Upload por Arquivos Individuais
  document.getElementById('btn-carregar-arquivos').addEventListener('click', () => {
    fileInputMultiple.click();
  });
  fileInputMultiple.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      processarArquivosXML(e.target.files);
    }
  });

  // Drag & Drop
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dragover');
  });
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      processarArquivosXML(e.dataTransfer.files);
    }
  });

  // Carregar Exemplos Embutidos
  document.getElementById('btn-carregar-exemplos').addEventListener('click', carregarExemplos);

  // Exportar CSV
  document.getElementById('btn-exportar-csv').addEventListener('click', exportarResultadosCSV);

  // Leitura de Imagem do Boleto
  const btnFoto = document.getElementById('btn-selecionar-foto');
  const inputFoto = document.getElementById('file-input-foto');
  const dropzoneFoto = document.getElementById('dropzone-foto');

  if (btnFoto && inputFoto) {
    btnFoto.addEventListener('click', () => inputFoto.click());
    inputFoto.addEventListener('change', (e) => {
      if (e.target.files.length > 0) processarFotoBoleto(e.target.files[0]);
    });
  }

  if (dropzoneFoto) {
    dropzoneFoto.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzoneFoto.classList.add('dragover');
    });
    dropzoneFoto.addEventListener('dragleave', () => dropzoneFoto.classList.remove('dragover'));
    dropzoneFoto.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzoneFoto.classList.remove('dragover');
      if (e.dataTransfer.files.length > 0) {
        const file = e.dataTransfer.files[0];
        if (file.type.startsWith('image/')) processarFotoBoleto(file);
      }
    });
  }

  // Suporte a colar print/texto na janela com Ctrl+V
  window.addEventListener('paste', (e) => {
    // 1. Verifica se colou uma IMAGEM (ex: print do WhatsApp Web)
    const items = (e.clipboardData || e.originalEvent.clipboardData).items;
    for (const item of items) {
      if (item.type.indexOf('image') !== -1) {
        const blob = item.getAsFile();
        processarFotoBoleto(blob);
        return;
      }
    }

    // 2. Se colou texto
    const texto = e.clipboardData.getData('text');
    if (texto && (texto.length === 47 || texto.length === 44 || texto.includes('.'))) {
      const dec = decodificarLinhaDigitavel(texto);
      if (dec.sucesso) {
        inputLinhaDigitavel.value = texto;
        inputValor.value = dec.valor.toFixed(2);
        state.filtros.valor = dec.valor;
        if (dec.dataVencimento) {
          inputVencimento.value = dec.dataVencimento;
          state.filtros.vencimento = dec.dataVencimento;
        }
        mostrarToast(`Linha colada! Valor: ${formatarMoeda(dec.valor)}`, 'success');
        executarBusca();
      }
    }
  });

  // Fechar Modal
  document.getElementById('modal-close-btn').addEventListener('click', fecharModal);
  document.getElementById('modal-danfe').addEventListener('click', (e) => {
    if (e.target.id === 'modal-danfe') fecharModal();
  });

  // Carrega busca inicial
  executarBusca();
});

// --------------------------------------------------------------------------
// 10. Módulo de OCR / Imagem do Boleto e Exportação CSV
// --------------------------------------------------------------------------
let ultimosResultadosBusca = [];

function salvarUltimosResultados(res) {
  ultimosResultadosBusca = res;
}

function exportarResultadosCSV() {
  if (!ultimosResultadosBusca || ultimosResultadosBusca.length === 0) {
    mostrarToast('Nenhum resultado para exportar.', 'warning');
    return;
  }

  let csv = 'Número NF;Série;Emissão;Emitente (Fornecedor);CNPJ Emitente;Destinatário;Valor Total NF;Tipo Match;Parcela Correspondente;Vencimento Parcela;Valor Parcela;Chave de Acesso\n';

  ultimosResultadosBusca.forEach(item => {
    const n = item.nota;
    const dup = item.duplicataAlvo;
    const tipo = item.tipoMatch === 'parcela' ? 'Parcela' : 'Valor Total';
    const nDup = dup ? dup.nDup : '-';
    const dVenc = dup ? formatarDataBR(dup.dVenc) : '-';
    const vDup = dup ? dup.vDup.toFixed(2).replace('.', ',') : '-';
    const vNF = (n.vNF || 0).toFixed(2).replace('.', ',');

    csv += `"${n.nNF}";"${n.serie}";"${formatarDataBR(n.dhEmi)}";"${n.emitente.nome}";"${n.emitente.cnpj}";"${n.destinatario.nome}";"${vNF}";"${tipo}";"${nDup}";"${dVenc}";"${vDup}";"${n.chave}"\n`;
  });

  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `boletos_cruzamento_${new Date().toISOString().split('T')[0]}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  mostrarToast('Planilha CSV gerada com sucesso!', 'success');
}

async function processarFotoBoleto(file) {
  const previewContainer = document.getElementById('foto-preview-container');
  const previewImg = document.getElementById('foto-preview');
  const statusEl = document.getElementById('foto-status');

  if (previewContainer && previewImg) {
    previewContainer.style.display = 'block';
    previewImg.src = URL.createObjectURL(file);
    statusEl.textContent = 'Carregando motor OCR...';
  }

  mostrarToast('Analisando foto do boleto...', 'info');

  try {
    // Carrega Tesseract dinamicamente se necessário
    if (!window.Tesseract) {
      statusEl.textContent = 'Baixando biblioteca de OCR...';
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
        script.onload = resolve;
        script.onerror = () => reject(new Error('Falha ao carregar Tesseract via CDN'));
        document.head.appendChild(script);
      });
    }

    statusEl.textContent = 'Lendo textos e números da imagem...';
    const worker = await Tesseract.createWorker('por');
    const ret = await worker.recognize(file);
    await worker.terminate();

    const texto = ret.data.text;
    statusEl.textContent = 'OCR Concluído!';

    // 1. Tenta extrair linha digitável na imagem
    const regexLinha = /\b\d{5}[\.\s]?\d{5}\s?\d{5}[\.\s]?\d{6}\s?\d{5}[\.\s]?\d{6}\s?\d\s?\d{14}\b/g;
    const matchLinha = texto.match(regexLinha);

    if (matchLinha && matchLinha.length > 0) {
      const linhaLimpa = matchLinha[0].replace(/\D/g, '');
      const dec = decodificarLinhaDigitavel(linhaLimpa);
      if (dec.sucesso) {
        document.getElementById('filtro-linha-digitavel').value = matchLinha[0];
        document.getElementById('filtro-valor').value = dec.valor.toFixed(2);
        state.filtros.valor = dec.valor;
        if (dec.dataVencimento) {
          document.getElementById('filtro-vencimento').value = dec.dataVencimento;
          state.filtros.vencimento = dec.dataVencimento;
        }
        mostrarToast(`Boleto reconhecido pela linha digitável! Valor: ${formatarMoeda(dec.valor)}`, 'success');
        executarBusca();
        return;
      }
    }

    // 2. Extração de Valor do Documento (ex: 282,52 ou Valor do Documento 282,52)
    const regexValor = /(?:Valor\s*(?:do\s*Documento)?|Valor\s*M[ií]nimo|R\$)\s*[:\s]*(\d{1,3}(?:\.\d{3})*,\d{2})/i;
    const matchValor = texto.match(regexValor) || texto.match(/(\d{1,3}(?:\.\d{3})*,\d{2})/);
    if (matchValor) {
      const v = parseFloat(matchValor[1].replace(/\./g, '').replace(',', '.'));
      if (v > 0) {
        document.getElementById('filtro-valor').value = v.toFixed(2);
        state.filtros.valor = v;
        mostrarToast(`Valor do Documento identificado: ${formatarMoeda(v)}`, 'success');
      }
    }

    // 3. Extração de "Seu Número" (Número da NF ou Fatura no DDA)
    const regexSeuNumero = /Seu\s*N[uú]mero\s*[:\s]*([0-9A-Za-z\-\/]+)/i;
    const matchSeuNumero = texto.match(regexSeuNumero);
    if (matchSeuNumero && matchSeuNumero[1]) {
      const num = matchSeuNumero[1].trim();
      document.getElementById('filtro-seu-numero').value = num;
      state.filtros.seuNumero = num;
      mostrarToast(`"Seu Número" (Nº NF) identificado: ${num}`, 'info');
    }

    // 4. Extração de Data do Vencimento (DD/MM/AAAA)
    const regexVenc = /Data\s*(?:do\s*)?Vencimento\s*[:\s]*(\d{2})[\/\-\.](\d{2})[\/\-\.](\d{4})/i;
    const matchVenc = texto.match(regexVenc);
    if (matchVenc) {
      const [_, dia, mes, ano] = matchVenc;
      const dataIso = `${ano}-${mes}-${dia}`;
      document.getElementById('filtro-vencimento').value = dataIso;
      state.filtros.vencimento = dataIso;
      mostrarToast(`Vencimento identificado: ${dia}/${mes}/${ano}`, 'info');
    }

    // 5. Extração de Data do Documento / Emissão (DD/MM/AAAA)
    const regexDataDoc = /Data\s*(?:do\s*)?Documento\s*[:\s]*(\d{2})[\/\-\.](\d{2})[\/\-\.](\d{4})/i;
    const matchDataDoc = texto.match(regexDataDoc);
    if (matchDataDoc) {
      const [_, dia, mes, ano] = matchDataDoc;
      const dataIso = `${ano}-${mes}-${dia}`;
      document.getElementById('filtro-data-doc').value = dataIso;
      state.filtros.dataDoc = dataIso;
    }

    // 6. Extração de Beneficiário Original ou CNPJ
    const regexCnpj = /\b\d{2}\.\d{3}\.\d{3}\/\d{4}\-\d{2}\b/;
    const matchCnpj = texto.match(regexCnpj);
    if (matchCnpj) {
      document.getElementById('filtro-fornecedor').value = matchCnpj[0];
      state.filtros.fornecedor = matchCnpj[0];
    }

    executarBusca();

  } catch (err) {
    console.warn('OCR em foto falhou ou sem internet para CDN:', err);
    if (statusEl) statusEl.textContent = 'OCR indisponível offline. Digite o valor manualmente.';
    mostrarToast('Não foi possível ler o texto da imagem automaticamente. Digite o valor do boleto.', 'warning');
  }
}

async function carregarExemplos() {
  mostrarToast('Carregando notas fiscais de exemplo...', 'info');

  try {
    // Tenta buscar as que criamos no diretório exemplos_xml/
    const res1 = await fetch('exemplos_xml/nota_exemplo_305432.xml');
    const xml1 = await res1.text();

    const res2 = await fetch('exemplos_xml/nota_exemplo_parcelada_8890.xml');
    const xml2 = await res2.text();

    const res3 = await fetch('exemplos_xml/nota_exemplo_dda_7900.xml');
    const xml3 = await res3.text();

    const nota1 = parseXmlNFe(xml1, 'nota_exemplo_305432.xml');
    const nota2 = parseXmlNFe(xml2, 'nota_exemplo_parcelada_8890.xml');
    const nota3 = parseXmlNFe(xml3, 'nota_exemplo_dda_7900.xml');

    const notas = [nota1, nota2, nota3].filter(Boolean);
    const mapa = new Map();
    state.notas.forEach(n => mapa.set(n.chave, n));
    notas.forEach(n => mapa.set(n.chave, n));
    state.notas = Array.from(mapa.values());

    await salvarNotasNoDB(state.notas);
    atualizarContadorNotas();
    mostrarToast('Notas de exemplo carregadas com sucesso!', 'success');
    executarBusca();
  } catch (err) {
    mostrarToast('Não foi possível carregar os exemplos via fetch. Selecione a pasta com os XMLs.', 'warning');
  }
}

