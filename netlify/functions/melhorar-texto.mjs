const MODEL = process.env.OPENAI_MODEL || "gpt-5.4-mini";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

const SYSTEM_PROMPT = `
Você é um assistente técnico especializado em Relatório Diário de Obras de implantação civil.

Sua função é melhorar descrições de atividades de obra e textos técnicos de relatório.

Regras obrigatórias:
1. Seja direto, profissional, técnico e limpo.
2. Não escreva texto longo demais.
3. Não invente informação.
4. Não invente datas, quantidades, locais, pessoas, modelos de equipamento ou marcas.
5. Não use floreio, marketing, opinião ou linguagem prolixa.
6. Não use markdown.
7. Não explique o que fez.
8. Entregue apenas o texto final melhorado.
9. Use português do Brasil.
10. Preserve o sentido original.
11. Substitua termos genéricos por vocabulário técnico de canteiro de obras quando houver evidência no texto ou na imagem.
12. Se houver imagem, analise visualmente a imagem e use apenas detalhes técnicos realmente observáveis.
13. Se o equipamento parecer uma escavadeira, descreva como "escavadeira hidráulica" apenas se visualmente ou textualmente compatível.
14. Só informe marca/modelo, como CAT, Komatsu, Volvo ou modelo específico, se estiver claramente visível na imagem ou explicitamente escrito no texto.
15. Se o modelo não for identificável, escreva "modelo não identificado" ou omita o modelo.
`.trim();

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return json(204, {});
  }

  if (event.httpMethod !== "POST") {
    return json(405, { error: "Método não permitido." });
  }

  try {
    if (!process.env.OPENAI_API_KEY) {
      return json(500, { error: "OPENAI_API_KEY não configurada no servidor." });
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
      return json(400, { error: "Envie texto ou imagem para análise." });
    }

    if (entrada.length > 5000) {
      return json(400, { error: "Texto muito longo." });
    }

    const userText = `
Tipo: ${tipo}
Contexto: ${contexto || "Relatório Diário de Obras"}

Descrição original:
${entrada || "(sem descrição textual)"}

Observação:
${obs || "(sem observação)"}

Tarefa:
Melhore tecnicamente a descrição da atividade. Se houver imagem anexada, use-a apenas para complementar com detalhes técnicos observáveis.
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
      temperature: 0.2,
      max_output_tokens: 500
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
