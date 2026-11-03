  document.addEventListener("DOMContentLoaded", () => {
       clickButton();
       changeFormRight();
       changeFormLeft();
       clickToSend();
  });

  const signInButton = document.getElementById('signIn');
  const sign = document.getElementById('sgn');
  const signup = document.getElementById('sgn-up');
  const name = document.getElementById('name');
  const mail = document.getElementById('mail');
  console.log(name);
  console.log(mail);
  const password = document.getElementById('password');
  const login = document.getElementById('login');
  const passwordd = document.getElementById('passwordism');
  const data = new Map();
  let err = document.getElementById("error");
  let error = document.getElementById("errorin");
  const submit = document.getElementById("submit");
  console.log(15, err);

  function clickButton() {
     sign.addEventListener("click", async (e) => {
		e.preventDefault();
        Login();
     })
  }

  function clickToSend() {
    signup.addEventListener("click", (e) => {
		e.preventDefault();
        Registration();
    })
  }

async function Login() {
  const response = await fetch("/api/login", {
      method: "POST",
      credentials: "include",
      headers: {
          "Content-Type": "application/json"
      },
      body: JSON.stringify({
          login: login.value,
          passwordd: passwordd.value
      })
  });

  const result = await response.json();

  console.log(15, result);
  if (response.ok) {
      window.location.href = "/account.html";
  } else if (!response.ok){
      error.textContent = result.message;
      error.style.color = "red";
      console.log(error);
  }
}

  const signUpButton = document.getElementById('signUp');
  const container = document.getElementById('container');

  function changeFormRight() {
      signUpButton.addEventListener('click', () => {
        container.classList.add("right-panel-active");
      });
  }

  function changeFormLeft() {
      signInButton.addEventListener('click', () => {
         container.classList.remove("right-panel-active");
      });
  }

async function checkRegistration() {
    const response = await fetch("/api/checkRegistration", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            checked: true
        })
    });

    const result = await response.json();

    if (!response.ok) {
        err.textContent = result.message;
        err.style.color = "red";
    } else {
        await Registration(); // дождаться окончания регистрации
    }
}

async function Registration() {
    const response = await fetch("/api/register", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            name: name.value,
            mail: mail.value,
            password: password.value
        })
    });
    const result = await response.json();
    console.log(56, result);
    if (!response.ok) {
       console.log(74, result.message);
       err.textContent = result.message;
       err.style.color = "red";
    } else {
       err.textContent = "Вы зарегистрировались !";
       err.style.color = "green";
       console.log(result.message);
    }
}