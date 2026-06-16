const MODEL = process.env.OPENAI_MODEL || "gpt-5.4-mini";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

const SYSTEM_PROMPT = `
Voce e um assistente tecnico especializado em Relatorio Diario de Obras (RDO) de implantacao civil.

Sua funcao e transformar descricoes curtas de campo em um texto tecnico mais completo, profissional e utilizavel em relatorio.

Regras obrigatorias:
1. Entregue apenas o texto final melhorado, sem explicacoes e sem markdown.
2. Escreva em portugues do Brasil, com tom tecnico de canteiro de obras.
3. Produza normalmente um paragrafo com 2 a 4 frases, entre 45 e 90 palavras.
4. Desenvolva um pouco a descricao, incluindo etapas operacionais genericas quando forem coerentes com a atividade: preparacao da area, execucao, conferencia, organizacao, limpeza, seguranca, continuidade dos servicos ou liberacao da frente.
5. Nao invente dados especificos: datas, horarios, quantidades, medidas, locais, nomes, pessoas, empresas, marcas, modelos, numero de equipes ou equipamentos.
6. Nao crie problemas, pendencias, ocorrencias ou conclusoes que nao estejam no texto original.
7. Preserve o sentido original e acrescente somente complementos tecnicos plausiveis e genericos.
8. Evite texto seco demais. O resultado deve parecer um registro completo de RDO, nao apenas uma correcao gramatical.
9. Substitua termos simples por vocabulario tecnico quando houver base no texto ou na imagem.
10. Se houver imagem, use apenas detalhes tecnicos realmente observaveis.
11. So informe marca/modelo de equipamento se estiver claramente visivel na imagem ou escrito no texto.
12. Se algum dado nao estiver claro, escreva de forma neutra, sem afirmar o que nao foi informado.
`.trim();

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return json(204, {});
  }

  if (event.httpMethod !== "POST") {
    return json(405, { error: "Metodo nao permitido." });
  }

  try {
    if (!process.env.OPENAI_API_KEY) {
      return json(500, { error: "OPENAI_API_KEY nao configurada no servidor." });
    }

    const body = JSON.parse(event.body || "{}");

    const {
      texto,
      descricao,
      observacao,
      contexto,
      tipo = "atividade",
      imageDataUrl
    } = body;

    const entrada = String(texto || descricao || "").trim();
    const obs = String(observacao || "").trim();

    if (!entrada && !imageDataUrl) {
      return json(400, { error: "Envie texto ou imagem para analise." });
    }

    if (entrada.length > 5000) {
      return json(400, { error: "Texto muito longo." });
    }

    const userText = `
Tipo: ${tipo}
Contexto: ${contexto || "Relatorio Diario de Obras"}

Descricao original:
${entrada || "(sem descricao textual)"}

Observacao:
${obs || "(sem observacao)"}

Tarefa:
Reescreva como um registro tecnico de RDO mais completo. Nao apenas corrija o portugues: desenvolva moderadamente a atividade, mantendo fidelidade ao que foi informado. Se houver imagem anexada, use-a apenas para complementar com detalhes tecnicos observaveis.
`.trim();

    const userContent = [
      { type: "input_text", text: userText }
    ];

    if (imageDataUrl && typeof imageDataUrl === "string" && imageDataUrl.startsWith("data:image/")) {
      userContent.push({
        type: "input_image",
        image_url: imageDataUrl
      });
    }

    const aiRes = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        instructions: SYSTEM_PROMPT,
        input: [
          {
            role: "user",
            content: userContent
          }
        ],
        temperature: 0.45,
        max_output_tokens: 700
      })
    });

    const response = await aiRes.json().catch(() => ({}));

    if (!aiRes.ok) {
      return json(aiRes.status, {
        error: response?.error?.message || `Erro ${aiRes.status} ao chamar a OpenAI.`
      });
    }

    const textoMelhorado =
      response.output_text ||
      response.output?.flatMap(item => item.content || [])
        ?.map(c => c.text || "")
        ?.join("\n")
        ?.trim();

    if (!textoMelhorado) {
      return json(500, { error: "Resposta vazia da IA." });
    }

    return json(200, { textoMelhorado });
  } catch (err) {
    console.error("[OPENAI_FUNCTION_ERROR]", err);
    return json(500, {
      error: err?.message || "Erro interno ao chamar IA."
    });
  }
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS"
    },
    body: JSON.stringify(body)
  };
}
