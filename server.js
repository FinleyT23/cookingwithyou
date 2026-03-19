require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const multer = require('multer');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── PostgreSQL ───────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// ─── Create recipes table if it doesn't exist ─────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recipes (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT DEFAULT 'user',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('Database ready.');
  await seedBaseRecipes();
}

// ─── Seed base recipes from /recipes folder ───────────────────────────────────
async function seedBaseRecipes() {
  const recipesDir = path.join(__dirname, 'recipes');
  if (!fs.existsSync(recipesDir)) {
    console.log('No /recipes folder found, skipping seed.');
    return;
  }

  const files = fs.readdirSync(recipesDir).filter(f => f.endsWith('.txt') || f.endsWith('.md'));

  for (const file of files) {
    const name = path.basename(file, path.extname(file));
    const content = fs.readFileSync(path.join(recipesDir, file), 'utf-8');

    // Only insert if not already in DB (avoid duplicates on server restart)
    const existing = await pool.query('SELECT id FROM recipes WHERE name = $1 AND source = $2', [name, 'base']);
    if (existing.rows.length === 0) {
      await pool.query('INSERT INTO recipes (name, content, source) VALUES ($1, $2, $3)', [name, content, 'base']);
      console.log(`Seeded base recipe: ${name}`);
    }
  }
}

// ─── File upload setup (memory, not disk) ────────────────────────────────────
const upload = multer({ storage: multer.memoryStorage() });

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /api/recipes — return all recipe names (not full content, for UI display)
app.get('/api/recipes', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, source, created_at FROM recipes ORDER BY source, name');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch recipes.' });
  }
});

// POST /api/recipes/upload — user uploads a recipe file, saved to shared DB
app.post('/api/recipes/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    const name = path.basename(req.file.originalname, path.extname(req.file.originalname));
    const content = req.file.buffer.toString('utf-8');

    // Check for duplicate
    const existing = await pool.query('SELECT id FROM recipes WHERE name = $1', [name]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: `A recipe named "${name}" already exists.` });
    }

    const result = await pool.query(
      'INSERT INTO recipes (name, content, source) VALUES ($1, $2, $3) RETURNING id, name, source',
      [name, content, 'user']
    );

    res.json({ success: true, recipe: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save recipe.' });
  }
});

// POST /api/suggest — main Claude API call
app.post('/api/suggest', async (req, res) => {
  try {
    const { ingredients, craving, dietary, cookTime, servings } = req.body;

    if (!ingredients || !craving) {
      return res.status(400).json({ error: 'Ingredients and craving are required.' });
    }

    // Fetch all recipes from DB
    const result = await pool.query('SELECT name, content, source FROM recipes ORDER BY source, name');
    const recipes = result.rows;

    if (recipes.length === 0) {
      return res.status(400).json({ error: 'No recipes in the database yet.' });
    }

    const recipeContext = recipes
      .map(r => `--- ${r.source === 'base' ? 'Base' : 'User'} Recipe: ${r.name} ---\n${r.content}`)
      .join('\n\n');

    const dietaryText = dietary && dietary.length > 0
      ? `Dietary restrictions: ${dietary.join(', ')}.`
      : 'No dietary restrictions specified.';

    const cookTimeText = cookTime && cookTime !== 'any' ? `Preferred cook time: ${cookTime}.` : '';
    const servingsText = servings ? `Servings needed: ${servings}.` : '';

    // Build an explicit list of valid recipe names for validation
    const validRecipeNames = recipes.map(r => r.name.toLowerCase());

    const systemPrompt = `You are CookingWithYou, a warm and knowledgeable recipe assistant with the personality of a seasoned home cook.

STRICT RULES — you must follow these without exception:
1. You may ONLY suggest recipes whose exact name appears in the recipe library below. No exceptions.
2. You must NEVER invent, paraphrase, combine, or reference any dish not present word-for-word in the provided library.
3. If no recipe is a good match, you must still pick the closest ones from the library and explain honestly what is missing — do not fill gaps with outside knowledge.
4. The "name" field in your JSON response must match a recipe name from the library EXACTLY, character for character.
5. If the library is empty or truly has nothing relevant, return an empty suggestions array — do not make anything up.

Valid recipe names you may use (you must only use names from this list):
${recipes.map(r => `- ${r.name}`).join('\n')}

Suggest up to 3 recipes ranked by how well they match the user's ingredients, craving, and preferences.

For each suggestion, respond with ONLY valid JSON in this exact format — no markdown, no explanation outside the JSON:
{
  "suggestions": [
    {
      "rank": 1,
      "name": "Recipe Name (must exactly match a name from the valid list above)",
      "matchReason": "Why this matches their craving and ingredients",
      "haveIngredients": ["ingredient1", "ingredient2"],
      "missingIngredients": ["ingredient3"],
      "cookTime": "approx time",
      "servings": "serves X",
      "methodSummary": "Brief 2-3 sentence summary of how to make it, drawn only from the recipe text",
      "matchScore": "Strong match / Good match / Closest available"
    }
  ]
}

Here is the full recipe library:\n\n${recipeContext}`;

    const userMessage = `Ingredients I have: ${ingredients}

What I'm feeling: ${craving}

${dietaryText}
${cookTimeText}
${servingsText}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }]
      })
    });

    const data = await response.json();
    const text = data.content?.map(b => b.text || '').join('') || '';

    // Strip markdown fences if Claude wraps in ```json
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    // ── Level 3 Validation ──────────────────────────────────────────────────
    // Reject any suggestion whose name doesn't exactly match a recipe in the DB.
    // This is the hard technical guarantee — even if Claude hallucinates a name,
    // it will never reach the user.
    const validated = parsed.suggestions.filter(s => {
      const isValid = validRecipeNames.includes(s.name.toLowerCase());
      if (!isValid) {
        console.warn(`Validation rejected hallucinated recipe: "${s.name}"`);
      }
      return isValid;
    });

    // Re-rank after filtering in case some were removed
    validated.forEach((s, i) => { s.rank = i + 1; });

    res.json({
      suggestions: validated,
      validationNote: validated.length < parsed.suggestions.length
        ? 'Some suggestions were removed because they did not match recipes in your library.'
        : null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`CookingWithYou running on port ${PORT}`));
});
