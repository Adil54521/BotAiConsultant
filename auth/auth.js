const bcrypt = require("bcrypt");
const pool = require("../db");

async function register(login, email, password) {
    const hash = await bcrypt.hash(password, 10);

    const result = await pool.query("SELECT current_database()");
    console.log(result.rows);

    const tables = await pool.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
    `);

    console.log(tables.rows);

    await pool.query(
        `INSERT INTO users(login, email, password, role_id)
         VALUES($1, $2, $3, 2)`,
        [login, email, hash]
    );
}

async function login(login, password) {
    const result = await pool.query(
        `SELECT
            u.*,
            r.name AS role
         FROM users u
         JOIN roles r
            ON r.id = u.role_id
         WHERE u.login = $1;`,
        [login]
    );

    if (result.rows.length === 0) {
        return null;
    }

    const user = result.rows[0];

    const match = await bcrypt.compare(
        password,
        user.password
    );

    if (!match) {
        return null;
    }

    return user;
}

async function getUserById(id) {
    const result = await pool.query(
        `
        SELECT
            u.id,
            u.login,
            u.email,
            u.created_at,
            r.name AS role
        FROM users u
        JOIN roles r
            ON r.id = u.role_id
        WHERE u.id = $1
        `,
        [id]
    );

    return result.rows[0];
}

async function updateUser(id, login, email) {
    await pool.query(
        `
        UPDATE users
        SET login = $1,
            email = $2
        WHERE id = $3
        `,
        [login, email, id]
    );
}

async function checkRegistration(id) {
    console.log("Подтверждение пользователя:", id);

    const result = await pool.query(
        `UPDATE users
         SET checked = TRUE
         WHERE id = $1
         RETURNING *`,
        [id]
    );

    console.log(result.rows);

    return result.rows[0];
}

async function getUncheckedUsers() {
    const result = await pool.query(`
        SELECT
            id,
            login,
            email,
            created_at
        FROM users
        WHERE checked = false
    `);

    return result.rows;
}

module.exports = {
    register,
    login,
    getUserById,
    updateUser,
    checkRegistration,
    getUncheckedUsers
};