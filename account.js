let allChats = [];
const request = document.querySelector(".request-card");
const aiChatPage = document.getElementById("aiChatPage");
const aiChatBtn = document.getElementById("aiChatBtn");
const aiChatList = document.getElementById("aiChatList");
const aiChatBody = document.getElementById("aiChatBody");
const aiUserName = document.getElementById("aiUserName");

let aiConversations = [];
let currentAIConversation = null;
let trainingInProgress = false;

function formatTime(date) {
    return new Date(date).toLocaleTimeString("ru-RU", {
        hour: "2-digit",
        minute: "2-digit"
    });
}

function formatDay(date) {

    const msgDate = new Date(date);

    const today = new Date();
    const yesterday = new Date();

    yesterday.setDate(today.getDate() - 1);

    const isSameDay = (a, b) =>
        a.getFullYear() === b.getFullYear() &&
        a.getMonth() === b.getMonth() &&
        a.getDate() === b.getDate();

    if (isSameDay(msgDate, today))
        return "Сегодня";

    if (isSameDay(msgDate, yesterday))
        return "Вчера";

    return msgDate.toLocaleDateString("ru-RU", {
        weekday: "long",
        day: "numeric",
        month: "long"
    });
}

async function deleteChat(chatId) {
    if (!confirm("Удалить чат?")) {
        return;
    }

    const response = await fetch(`/api/chat/${chatId}`, {
        method: "DELETE"
    });

    const result = await response.json();

    if (!response.ok) {
        alert(result.message);
        return;
    }

    document
        .querySelector(`.chat-item[data-chat-id="${chatId}"]`)
        ?.remove();

    if (currentChatId === chatId) {
        currentChatId = null;
        document.getElementById("chatBody").innerHTML = "";

        const firstChat = document.querySelector(".chat-item");

        if (firstChat) {
            openChat(firstChat.dataset.chatId);
        }
    }

    alert(result.message);
}
const exit = document.getElementById("exit");

async function logout() {

    const response = await fetch("/api/logout", {
        method: "POST",
        credentials: "include"
    });

    const result = await response.json();

    if (response.ok) {
        window.location.href = "/aithorization_form.html";
    } else {
        alert(result.message);
    }
}

exit.addEventListener("click", logout);

function initEditMode() {
    const editBtn = document.getElementById("editBtn");
    let editing = false;

    editBtn.addEventListener("click", () => {
        editing = !editing;

        const inputs = document.querySelectorAll(
            "#login, #email, #password"
        );

        inputs.forEach(input => {
            input.readOnly = !editing;
        });

        editBtn.textContent = editing
            ? "Отключить редактирование"
            : "Редактировать";
    });
}

let currentChatId = null;
let currentStudentId = null;

async function loadChats() {
    const response = await fetch("/api/chat");

    if (!response.ok) {
        console.error("Не удалось загрузить чаты");
        return;
    }

    const chats = await response.json();
    allChats = chats;

    const chatList = document.querySelector(".chat-list");
    chatList.innerHTML = "";

    chats.forEach(chat => {
        const chatItem = document.createElement("div");

        chatItem.className = "chat-item";
        chatItem.dataset.chatId = chat.id;
        chatItem.dataset.studentId = chat.student_id;

        chatItem.innerHTML = `
            <div class="name">${chat.student_name}</div>
            <div class="phone">${chat.phone}</div>
            <div class="last-message"></div>
            <button class="delete-chat">🗑</button>
        `;

        chatItem.addEventListener("click", () => {
            openChat(chat.id);
        });

        chatItem
            .querySelector(".delete-chat")
            .addEventListener("click", e => {
                e.stopPropagation();
                deleteChat(chat.id);
            });

        chatList.appendChild(chatItem);
    });

    if (chats.length > 0) {
        openChat(chats[0].id);
    }
}

async function loadProfile() {
    const response = await fetch("/api/profile", {
        credentials: "include"
    });

    const user = await response.json();

    if (!response.ok) {
        console.error(user.message);
        return;
    }

    document.getElementById("login").value = user.login;
    document.getElementById("email").value = user.email;
    document.getElementById("date").value = user.created_at;
}

const saveBtn = document.getElementById("saveBtn");

saveBtn.addEventListener("click", saveProfile);

async function saveProfile() {
    const response = await fetch("/api/profile", {
        method: "PUT",
        credentials: "include",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            login: document.getElementById("login").value,
            email: document.getElementById("email").value
        })
    });

    const result = await response.json();

    if (response.ok) {
        alert(result.message);
    } else {
        alert(result.message);
    }
}

function renderAIMessages(messages) {

    aiChatBody.innerHTML = "";

    let lastDay = "";

    messages.forEach(message => {

        const day = formatDay(message.created_at);

        if (day !== lastDay) {

            aiChatBody.innerHTML += `
                <div class="date-divider">
                    ${day}
                </div>
            `;

            lastDay = day;
        }

        const role =
            message.role === "user"
                ? "user"
                : "bot";

        aiChatBody.innerHTML += `
            <div class="ai-message ${role}">
                <div class="ai-bubble">

                    ${message.message}

                    <div class="ai-time">
                        ${formatTime(message.created_at)}
                    </div>

                </div>
            </div>
        `;

    });

    aiChatBody.scrollTop = aiChatBody.scrollHeight;
}

async function openAIConversation(id, element) {

    currentAIConversation = id;

    document
        .querySelectorAll(".ai-chat-item")
        .forEach(item => item.classList.remove("active"));

    element.classList.add("active");

    const chat = aiConversations.find(x => x.id === id);

    aiUserName.textContent =
        chat.full_name || chat.username || chat.telegram_id || chat.phone;

    const response = await fetch(`/api/ai/conversations/${id}`);

    if (!response.ok) {

        alert("Не удалось загрузить сообщения");

        return;
    }

    const messages = await response.json();

    renderAIMessages(messages);

}

function renderAIConversations() {

    aiChatList.innerHTML = "";

    aiConversations.forEach(chat => {

        aiChatList.innerHTML += `
            <div
                class="ai-chat-item"
                data-id="${chat.id}"
                onclick="openAIConversation(${chat.id}, this)">

                <div class="ai-name">
                    ${chat.full_name || chat.username}
                </div>

                <div class="ai-phone">
                    ${chat.phone ?? ""}
                </div>

                <div class="ai-date">
                    ${new Date(chat.updated_at).toLocaleString("ru-RU")}
                </div>

            </div>
        `;

    });

}

async function loadAIConversations() {

    const response = await fetch("/api/ai/conversations");

    if (!response.ok) {

        alert("Не удалось загрузить диалоги");

        return;
    }

    aiConversations = await response.json();

    renderAIConversations();
}

const profilePage = document.getElementById("profilePage");
const chatPage = document.getElementById("chatPage");
const trainingPage = document.getElementById("trainingPage");
const documentscard = document.querySelector(".documents-card");

function openPage(pageName) {
    profilePage.style.display = "none";
    chatPage.style.display = "none";

    if (pageName === "profile") {
        profilePage.style.display = "block";
        trainingPage.style.display = "none";
        documentscard.style.display = "none";
        aiChatPage.style.display = "none";
    }

    if (pageName === "chat") {
        chatPage.style.display = "block";
        trainingPage.style.display = "none";
        documentscard.style.display = "none";
        aiChatPage.style.display = "none";
    }

    if (pageName === "training") {
        trainingPage.style.display = "block";
        documentscard.style.display = "block";
        aiChatPage.style.display = "none";
    }

    if (pageName === "dialog") {
        trainingPage.style.display = "none";
        documentscard.style.display = "none";
        aiChatPage.style.display = "block";
    }
}

document.getElementById("profileBtn").addEventListener("click", e => {
    e.preventDefault();
    openPage("profile");
});

document.getElementById("chatBtn").addEventListener("click", e => {
    e.preventDefault();
    openPage("chat");
});

document.getElementById("trainingBtn").addEventListener("click", e => {
    e.preventDefault();
    openPage("training");
});

document.getElementById("aiChatBtn").addEventListener("click", e => {
    e.preventDefault();
    openPage("dialog");
    loadAIConversations();
});


const trainInput = document.getElementById("trainFiles");
const trainList = document.getElementById("trainFileList");

let files = [];

const MAX_SIZE = 20 * 1024 * 1024; // 20 МБ

trainInput.addEventListener("change", () => {

    files = [];
    trainList.innerHTML = "";

    [...trainInput.files].forEach(file => {

        if (file.size > MAX_SIZE) {
            alert(`Файл "${file.name}" превышает 20 МБ.`);
            return;
        }

        files.push(file);

        const div = document.createElement("div");

        div.className = "train-file";

        div.innerHTML = `
            <span>${file.name}</span>
            <span>${(file.size / 1024 / 1024).toFixed(2)} MB</span>
        `;

        trainList.append(div);
    });

});

async function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        console.log(15, reader);
        reader.onload = () => resolve(reader.result.split(",")[1]);
        reader.onerror = reject;

        reader.readAsDataURL(file);
    });
}
const deleten = document.querySelectorAll(".delete-btn");
const uploadTrainingBtn = document.getElementById("uploadTrainingBtn");

async function uploadTraining() {
    if (files.length === 0) {
        alert("Выберите файлы");
        return;
    }

    const form = new FormData();

    for (const file of files) {
        form.append("files", file);
    }

    try {
        document.querySelector(".progress-box").style.display = "block";

        const response = await fetch("/api/ai", {
            method: "POST",
            body: form
        });

        const text = await response.text();
        console.log(text);

        if (response.ok) {
            trainingInProgress = true;
            document.querySelectorAll(".delete-btn").forEach(btn => {
                btn.disabled = true;
            });
            uploadTrainingBtn.disabled = true;
            loadDocuments();
        } else {
            alert(text);
        }
    } catch (err) {
        console.error(err);
        alert("Ошибка загрузки файлов");
    }
}

uploadTrainingBtn.onclick = uploadTraining;

const ws = new WebSocket(`wss://${location.host}/ws`);

ws.onopen = () => {
    console.log("WebSocket подключен");
};

const chatList = document.querySelector(".chat-list");

function renderMessage(sender, text) {
    const chatBody = document.getElementById("chatBody");

    const messageDiv = document.createElement("div");
    messageDiv.className = "message";

    if (sender === "employee") {
        messageDiv.classList.add("me");
    } else {
        messageDiv.classList.add("student");
    }

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = text;

    messageDiv.appendChild(bubble);
    chatBody.appendChild(messageDiv);

    chatBody.scrollTop = chatBody.scrollHeight;
}

function renderChats(chats) {
    const chatItems = document.getElementById("chatItems");
    chatItems.innerHTML = "";

    chats.forEach(chat => {
        const item = document.createElement("div");

        item.className = "chat-item";

        if (chat.id === currentChatId) {
            item.classList.add("active");
        }

        item.innerHTML = `
            <div class="name">${chat.student_name}</div>
            <div class="phone">${chat.phone || ""}</div>
            <div class="last-message">${chat.last_message || ""}</div>
            <button class="delete-chat-btn" data-id="${chat.id}">🗑</button>
        `;

        item.addEventListener("click", () => {
            openChat(chat.id);
        });

        const deleteBtn = item.querySelector(".delete-chat-btn");

        deleteBtn.addEventListener("click", async e => {
            e.stopPropagation();
            await deleteChat(chat.id);
        });

        chatItems.appendChild(item);
    });
}

async function checkRegistration(e) {
    if (!e.target.classList.contains("submit")) {
        return;
    }

    const id = e.target.dataset.id;

    await fetch("/api/checkRegistration", {
        method: "POST",
        credentials: "include",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            id: Number(id)
        })
    });
}

async function loadRequests() {
    const response = await fetch("/api/getUncheckedUsers");

    if (!response.ok) {
        console.error("Ошибка получения заявок");
        return;
    }

    const users = await response.json();

    if (!users.length) return;

    // Если блок уже существует, удаляем его
    document.querySelector(".prereg")?.remove();

    const profilePage = document.getElementById("profilePage");
    const card = profilePage.querySelector(".card");

    // Создаем блок заявок
    const prereg = document.createElement("div");
    prereg.className = "prereg";

    const title = document.createElement("h1");
    title.textContent = "Заявки на регистрацию";

    prereg.append(title);

    // Вставляем после карточки профиля
    card.after(prereg);

    users.forEach(user => {
        const request = document.createElement("div");
        request.className = "request";

        const name = document.createElement("div");
        name.className = "name";
        name.textContent = user.login;

        const mail = document.createElement("div");
        mail.className = "mail";
        mail.textContent = user.email;

        const requestCard = document.createElement("div");
        requestCard.className = "request-card";

        const button = document.createElement("button");
        button.className = "submit";
        button.textContent = "Подтвердить";
        button.dataset.id = user.id;

        button.addEventListener("click", checkRegistration);

        requestCard.append(button);

        request.append(name);
        request.append(mail);
        request.append(requestCard);

        prereg.append(request);
    });
}

function updateStudentStatus(studentId, enabled) {
    console.log("STATUS EVENT:", studentId, enabled, typeof enabled);
    console.log("CURRENT STUDENT:", currentStudentId, typeof currentStudentId);

    if (String(currentStudentId) !== String(studentId)) {
        console.log("STATUS SKIPPED: другой студент");
        return;
    }

    const status = document.querySelector(".student-status");

    if (!status) {
        console.log("STATUS ELEMENT NOT FOUND");
        return;
    }

    if (enabled === true) {
        status.classList.remove("offline");
        status.classList.add("online");
        status.textContent = "● Онлайн";

        console.log("STATUS SET: ONLINE");
    } else {
        status.classList.remove("online");
        status.classList.add("offline");
        status.textContent = "● Офлайн";

        console.log("STATUS SET: OFFLINE");
    }
}

ws.onmessage = event => {
    const data = JSON.parse(event.data);

    if (data.type === "new_message") {
        // Добавляем сообщение в открытый чат
        if (String(currentChatId) === String(data.chatId)) {
            renderMessage("student", data.text);
        }

        let chatItem = document.querySelector(
            `.chat-item[data-chat-id="${data.chatId}"]`
        );

        if (chatItem) {
            // Чат уже существует — обновляем последнее сообщение
            chatItem.querySelector(".last-message").textContent = data.text;
        } else {
            // Новый студент — создаем новый чат
            chatItem = document.createElement("div");

            chatItem.className = "chat-item";
            chatItem.dataset.chatId = data.chatId;
            chatItem.dataset.studentId = data.studentId;

            chatItem.innerHTML = `
                <div class="name">${data.studentName}</div>
                <div class="phone">${data.phone}</div>
                <div class="last-message">${data.text}</div>
                <button class="delete-chat">🗑</button>
            `;

            chatItem.addEventListener("click", () => {
                openChat(
                    data.chatId,
                    data.studentId,
                    data.studentName
                );
            });

            chatItem
                .querySelector(".delete-chat")
                .addEventListener("click", e => {
                    e.stopPropagation();
                    deleteChat(data.chatId);
                });

            chatList.appendChild(chatItem);
        }
    }

    if (data.type === "consultant_mode_changed") {
        updateStudentStatus(
            data.studentId,
            data.enabled
        );
    }

    if(data.type === "training_progress"){
        document.getElementById("trainProgress").style.width =
            data.percent + "%";

        document.getElementById("progressText").textContent =
            `${data.current}/${data.total} чанков`;
    }

    if(data.type === "training_finish"){

        document.getElementById("trainProgress").style.width = "100%";

        document.getElementById("progressText").textContent =
            "Обучение завершено";
        document.querySelectorAll(".delete-btn").forEach(btn => {
            btn.disabled = false;
        });
        trainingInProgress = false;
        uploadTrainingBtn.disabled = false;
    }

};

async function loadConsultantStatus(studentId) {
    const response = await fetch(
        `/api/consultant-mode?studentId=${studentId}`
    );

    if (!response.ok) {
        return;
    }

    const data = await response.json();

    updateStudentStatus(
        data.studentId,
        data.enabled
    );
}

function formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} Б`;

    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} КБ`;

    const mb = kb / 1024;
    if (mb < 1024) return `${mb.toFixed(1)} МБ`;

    const gb = mb / 1024;
    return `${gb.toFixed(2)} ГБ`;
}

async function loadDocuments() {
    try {
        const response = await fetch("/api/documents");

        if (!response.ok) {
            throw new Error("Не удалось загрузить документы");
        }

        const documents = await response.json();

        const tbody = document.getElementById("documentsTable");
        tbody.innerHTML = "";

        if (documents.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="4" style="text-align:center;color:#777;">
                        Документы отсутствуют
                    </td>
                </tr>
            `;
            return;
        }

        documents.forEach(doc => {
            tbody.innerHTML += `
                <tr>
                    <td>${doc.title}</td>
                    <td>${formatFileSize(doc.file_size)}</td>
                    <td>${new Date(doc.uploaded_at).toLocaleString("ru-RU")}</td>
                    <td>
                        <button
                            class="delete-btn"
                            onclick="deleteDocument(${doc.id})"
                            ${trainingInProgress ? "disabled" : ""}
                        >
                            Удалить
                        </button>
                    </td>
                </tr>
            `;
        });

    } catch (err) {
        console.error(err);
        alert("Ошибка загрузки документов.");
    }
}

async function deleteDocument(id){

    if(!confirm("Удалить этот документ?")){
        return;
    }

    const res = await fetch(`/api/documents/${id}`,{
        method:"DELETE"
    });

    if(res.ok){
        loadDocuments();
    }else{
        alert("Не удалось удалить документ.");
    }

}

async function openChat(chatId) {
    currentChatId = chatId;

    const studn = document.getElementById("studentName");

    const activeItem = document.querySelector(
        `.chat-item[data-chat-id="${chatId}"]`
    );

    if (!activeItem) {
        return;
    }

    currentStudentId = activeItem.dataset.studentId;

    document.querySelectorAll(".chat-item").forEach(item => {
        item.classList.remove("active");
    });

    activeItem.classList.add("active");

    const name = activeItem.querySelector(".name");

    if (name) {
        studn.textContent = name.textContent;
    }

    await loadConsultantStatus(currentStudentId);

    const response = await fetch(
        `/api/message?chatId=${chatId}`
    );

    if (!response.ok) {
        return;
    }

    const messages = await response.json();

    const chatBody = document.getElementById("chatBody");
    chatBody.innerHTML = "";

    messages.forEach(message => {
        renderMessage(
            message.sender,
            message.text
        );
    });
}

const sendBtn = document.getElementById("sendBtn");

sendBtn.addEventListener("click", sendMessage);

async function sendMessage() {
    if (!currentChatId) {
        return;
    }

    const input = document.getElementById("messageInput");
    const text = input.value.trim();

    if (!text) {
        return;
    }

    const response = await fetch("/api/send-message", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            chatId: currentChatId,
            text: text
        })
    });

    if (response.ok) {
        renderMessage("employee", text);
        input.value = "";
    }
}

document.addEventListener("DOMContentLoaded", () => {
    initEditMode();
    loadProfile();
    loadChats();
    loadRequests();
    loadDocuments();
    const chatSearchInput = document.getElementById("chatSearchInput");

    if (chatSearchInput) {
        chatSearchInput.addEventListener("input", () => {
            const value = chatSearchInput.value
                .toLowerCase()
                .trim();

            const filteredChats = allChats.filter(chat => {
                const name = String(chat.student_name || "")
                    .toLowerCase();

                const phone = String(chat.phone || "")
                    .toLowerCase();

                return (
                    name.includes(value) ||
                    phone.includes(value)
                );
            });

            renderChats(filteredChats);
        });
    }
});