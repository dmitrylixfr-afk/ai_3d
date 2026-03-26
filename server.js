require('dotenv').config();
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const cors = require("cors");
const os = require("os");
const path = require("path");

const app = express();
// Настройка multer для работы с системной временной папкой (важно для Vercel)
const upload = multer({ dest: os.tmpdir() });

app.use(cors());
app.use(express.json());

// Отдаем статические файлы (HTML, CSS, JS) из корня
app.use(express.static(path.join(__dirname, ".")));

async function getAICaption(imageBuffer, token) {
    const cleanToken = (token ?? "").trim();
    const modelUrl = "https://api.openai.com/v1/chat/completions";
    const base64Image = imageBuffer.toString("base64");

    console.log(">>> [OpenAI]: Отправка запроса к Vision API...");
    const response = await fetch(modelUrl, {
        headers: {
            Authorization: `Bearer ${cleanToken}`,
            "Content-Type": "application/json"
        },
        method: "POST",
        body: JSON.stringify({
            model: "gpt-4o",
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } },
                        { type: "text", text: "Describe what you see in this image in one word." }
                    ]
                }
            ],
            max_tokens: 10
        })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || "Ошибка OpenAI API");
    return data.choices[0].message.content;
}

// Маршрут для генерации 3D
app.post("/generate", upload.single("image"), async (req, res) => {
    try {
        if (!req.file) return res.status(400).send("Файл не выбран");
        
        if (!process.env.OPENAI_API_KEY || !process.env.TRIPO_KEY) {
            return res.status(500).send("API ключи не настроены в Environment Variables");
        }

        const imageBuffer = fs.readFileSync(req.file.path);
        const caption = await getAICaption(imageBuffer, process.env.OPENAI_API_KEY);
        
        console.log(">>> [Tripo3D]: Генерация модели для:", caption);
        const tripoRes = await fetch("https://api.tripo3d.ai/v2/openapi/task", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${process.env.TRIPO_KEY.trim()}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                type: "text_to_model",
                prompt: caption,
                model_version: "P1-20260311",
                texture: true
            })
        });

        const tripoData = await tripoRes.json();
        if (tripoData.code !== 0) throw new Error(tripoData.message);

        const taskId = tripoData.data.task_id;
        let modelUrl = "";

        // Опрос статуса задачи (макс 50 секунд для Vercel)
        for (let i = 0; i < 25; i++) {
            await new Promise(r => setTimeout(r, 2000));
            const check = await fetch(`https://api.tripo3d.ai/v2/openapi/task/${taskId}`, {
                headers: { "Authorization": `Bearer ${process.env.TRIPO_KEY.trim()}` }
            });
            const statusData = await check.json();
            const status = statusData.data?.status?.toLowerCase();
            
            if (status === "succeeded" || status === "success") {
                modelUrl = statusData.data.output?.pbr_model || statusData.data.result?.pbr_model?.url;
                break;
            } else if (status === "failed") throw new Error("Tripo3D генерация провалена");
        }

        if (!modelUrl) throw new Error("Превышено время ожидания (Timeout)");
        res.json({ object: caption, model: modelUrl });
    } catch (err) {
        console.error("Ошибка сервера:", err.message);
        res.status(500).send(err.message);
    } finally {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    }
});

// Маршрут для скачивания файла
app.get("/download", async (req, res) => {
    try {
        const fileUrl = req.query.url;
        const response = await fetch(fileUrl);
        const buffer = await response.arrayBuffer();
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Disposition", `attachment; filename="model.glb"`);
        res.send(Buffer.from(buffer));
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// Для локального запуска (не мешает Vercel)
if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}

// ЭКСПОРТ ДЛЯ VERCEL (Критически важно!)
module.exports = app;