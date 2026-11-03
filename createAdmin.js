const bcrypt = require("bcrypt");
const pool = require("./db"); // путь такой же, как в проекте

async function createAdmin() {
    const hash = await bcrypt.hash("uK@$*~", 10);

    await pool.query(
        `
        INSERT INTO users (
            login,
            email,
            password,
            checked,
            role_id
        )
        VALUES ($1, $2, $3, TRUE, 1)
        `,
        [
            "admin",
            "admin@example.com",
            hash
        ]
    );

    console.log("Администратор создан");
    process.exit();
}

createAdmin().catch(err => {
    console.error(err);
    process.exit(1);
});