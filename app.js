const express    = require('express'); //Подключим фреймворк express
const app        = express(); //Иницилизируем фреймворк
const http       = require('http'); //Подключаем библиотеку с http сервером
const server     = http.createServer(app); //Создаем http сервер
const { Server } = require("socket.io"); //Подключаемм библиотеку с websocket
const cors       = require('cors'); //Подключаем библиотеку CORS
const mysql      = require('mysql2'); //Подключаем библиотеку для работы с mysql базой данных
const io         = new Server(server, { cors: { origin: '*' } }); //Делаем доступ к серверу для любых внешних подключений

let gamers = new Set(); //Множество имен игроков. Используем для того, чтобы не было игроков с одинаковыми именами
let waitingGamers = []; //Массив ожидающих поиграть игроков
let roomsParticipant = {}; //Комнаты участников. Каждая игра будет проходить в отдельной комнате
let roomsGamers = {}; //Список участников игры
let roomsScore = {}; //Счет игр
let roomsLastCity = {}; //Последний выбранный город в каждой игре

//подключаемся к базе данных, где хранятся города
const mysqlConf = {
	host: 'localhost',
	user: 'user',
	password: 'password',
	database: 'cities'
};

//Функция последней буквы в названии города
const lastLetter = (town) => { 
    let lastletter;
	//Обходим слово посимвольно с конца.
	for (let i = -1; i > -town.length; i--) {
		//Забираем текущую букву в цикле
        lastletter = town.substr(i, 1);
		//Если там нет ы,ь,ъ то возвращаем эту букву, иначе переходим 
		// к следующей букве с конца
        if (['ь','ъ','ы'].indexOf(lastletter) === -1) {
            break;
        }
    }
    return lastletter;
}
//Делаем доступным сервер к другим серверам
app.use(cors());
//Заглушка на главной странице
app.get("/", ( req, res ) => {
	return res.send('API игры в города');
});
//API: Информация о городе по его названию.
app.get("/city/:city", ( req, res ) => {
	//Делаем запрос к базе данных и получаем на выходе название, долготу и широту
	//этого города.
	const connection = mysql.createConnection(mysqlConf);
	//Так как городов с одинаковым названием может быть несколько, то используем 
	//сортировку рандомом и возвращаем самый первый из них.
	connection.query(
		'SELECT name, latitude, longitude FROM city \
		 WHERE name = ? \
		 ORDER BY RAND() \
		 LIMIT 1',
		 //Название города предварительно тримируем. 
		 //Название должно начинаться с заглавной буквы
		[`${req.params.city.trim()}`],
		function(err, results, fields) {
			//Если во время запроса произошла ошибка, то выводим эту ошибку
			if (err !== null) {
				return res.send({
					error: err,
				});
			}
			//После выполнения запроса сразу закрываем соединение
			connection.close();
			//Если из базы был получен хотя бы 1 город, то выводим его в формате JSON
			if (results[0] !== undefined) {
				return res.send({
					city: results[0].name.trim(),
					latitude: results[0].latitude,
					longitude: results[0].longitude,
				});
			}
			//В противном случае вернем ошибку, что такого города нет.
			return res.send({
				no: 'Такого города не существует',
			});
		}
	);	
});
//API: Получим случайный город, начинающий на определенную букву
app.get("/lastletter/:letter", ( req, res ) => {
	//Делаем запрос к базе данных
	const connection = mysql.createConnection(mysqlConf);
	//Получаем список всех городов, которые начинаются на нужную нам букву
	//путем, получения рандомного числа от общего количества городов в базе
	//далее получение списка городов, чей id больше или равно рандомному числу
	//далее сортируем весь список функцией рандом и забираем 1 город из нового списка
	connection.query(
		'SELECT name, latitude, longitude FROM city \
		WHERE id >= (SELECT ROUND( \
			RAND()* \
			(SELECT MAX(id) FROM city )) AS id ) AND name LIKE ? \
		ORDER BY RAND() \
		LIMIT 1',
		//На всякий случай делаем букву заглавной
		[`${req.params.letter.toUpperCase()}%`],
		function(err, results, fields) {
			//Если во время запроса произошла ошибка, то выводим эту ошибку
			if (err !== null) {
				return res.send({
					error: err,
				});
			}
			//После выполнения запроса сразу закрываем соединение
			connection.close();
			//Если из базы был получен хотя бы 1 город, то выводим его в формате JSON
			if (results[0] !== undefined) {
				return res.send({
					city: results[0].name_ru.trim(),
					latitude: results[0].latitude,
					longitude: results[0].longitude,
				});
			}
			//В противном случае вернем ошибку, что что-то пошло не так.
			return res.send({
				error: 'Что-то пошло не так',
			});
		}
	);	
});
//Сокет-сервер для многопользовательской игры
//Все события сервера описывается в connection
io.on('connection', socket => {
	//сокет старта игры. Присылается клиентом, когда он готов начать игру
	socket.on("start", (name) => {
		//Проверим для начала, если ли в игре уже игрок с таким именем
		if (gamers.has(name)) {
			//Если такое имя уже есть, то отправим клиенту сообщение ошибки
			io.to(socket.id).emit('error', {
				type: 'pre_game',
				text: 'Данное имя уже занято'
			});
		//Иначе подготавливаем игру
		} else {
			// добавляем имя пользователя в множество имен
			gamers.add(name);
			//Добавим пользователя в список ожидающих игроков
			waitingGamers[name] = socket;
			//Переделываем список ожидающих, чтобы его можно было итеррировать
			let waitingGamersKeys = Object.keys(waitingGamers);
			//Если количество ожидающих равно 2, то начинаем игру
			//Иначе ожидаем, пока кто-то не присоеденился еще 
			if (waitingGamersKeys.length == 2) {
				//Как только присоеденился 2 игрок, то появляется возможность
				//создать комнату сервера для игры
				//Генерируем номер комнаты
				let room = Math.floor(Math.random()*9999999);
				//создаем комнату в переменную игроков в паре
				roomsParticipant[room] = {};
				//создаем комнату в переменную счета игры
				roomsScore[room] = [0, 0];
				//J - переменная отсева. Если вдруг в ожидании будут 3 и более игрока
				let j = 0;
				//Обходим всех игроков в очереди
				waitingGamersKeys.forEach((i) => {
					//присоединяем к комнате каждого из 2 игроков
					waitingGamers[i].join(room);
					//в переменную участников добавляем id участника
					// и его порядковый номер для очередности хода
					roomsParticipant[room][i] = [waitingGamers[i].id, j];
					//в переменную связи комната - игроки добавляем номер комнаты
					roomsGamers[waitingGamers[i].id] = room;
					//увеличиваем счетчик очередности и удаляем игрока из очереди ожидания
					j++;
					delete waitingGamers[i];
					//3 игрока и всех следующих выкидываем и подключаем в следующей итерации
					if (j > 1) {
						return;
					}
				});
				//отправляем сообщение всем игрокам в комнате о том, что все участники подключились
				//и игра началась со списком игроков в комнате и номер комнаты
				io.to(room).emit('wait', {
					room,
					gamers: roomsParticipant[room],
				});
			}
		}
	});
	//Сообщение об отправленном городе от участника
	socket.on("sendCity", (data) => {
		//Сохраняем счет игры и обрабатываем его
		roomsScore[data.room] = data.score;
		//Счет записываем следующим образом. Количество баллов у ведущего игрока - это разность
		//между очками обоих игроков, у отстающего будет 0 
		if (roomsScore[data.room][0] > roomsScore[data.room][1]) {
			roomsScore[data.room] = [roomsScore[data.room][0] - roomsScore[data.room][1], 0];
		} else if (roomsScore[data.room][0] < roomsScore[data.room][1]) {
			roomsScore[data.room] = [0, roomsScore[data.room][1] - roomsScore[data.room][0]];
		} else {
			//В случае ничьи счет 0:0
			roomsScore[data.room] = [0, 0];
		}
		//Если в переменной последнего города игры что-то есть, значит это уже второй ход
		//значит нужно предварительно проверять, что новый город начинается с последней буквы
		//предыдущего города 
		if (roomsLastCity[data.room] !== undefined) {
			//Если условие выполнено, то отправим сообщение в комнату для оповещения другого игрока
			//что теперь его ход и отправим также информацию о последнем городе
			if (data.city.city[0].toUpperCase() === roomsLastCity[data.room]) {
				io.to(data.room).emit('getCity', {
					score: roomsScore[data.room],
					city: data.city,
					name: data.name,
				});
				//обновим переменную последнего города
				roomsLastCity[data.room] = lastLetter(data.city.city).toUpperCase();
			} else {
				//Если условие не выполнено, то отправим ошибку игроку, чтобы он поменял город
				io.to(socket.id).emit('error', {
					type: 'in_game',
					text: 'Город должен начинаться с последней буквы прошлого города.'
				});
			}
		} else {
			//Если это первый ход, то просто отправим информацию о городе в комнате, 
			// счет при этом менятся не будет, так как не с чем сравнивать
			io.to(data.room).emit('getCity', {
				score: data.score,
				city: data.city,
				name: data.name,
			});
			//обновим переменную последнего города
			roomsLastCity[data.room] = lastLetter(data.city.city).toUpperCase();
		}
	});
	//Если 1 из игроков покидает игру, то сообщаем об этом другого и завершаем игру,
	//выводя счет
	socket.on("disconnecting", (reason) => {
		//получаем номер комнаты, в которой играл вышедший игрок
		const room = roomsGamers[socket.id];
		//обходим всех игроков комнаты
		for (let name in roomsParticipant[room]) {
			//ощищаем связь игрок - комната
			delete roomsGamers[roomsParticipant[room][name][0]];
			//удаляем всех игроков из множества имен, чтобы можно было
			//занять его снова
			gamers.delete(name);
			//Отправим сообщение оставшемуся игроку
			if (socket.id === roomsParticipant[room][name][0]) {
				io.to(room).emit("exit", {
					name,
					score: roomsScore[room],
				});
			}
		}
		//удаляем счет
		delete roomsScore[room];
		//удаляем информацию об участниках игры
		delete roomsParticipant[room];
	});
});
//Запускаем игровой сервер на порту 1949
server.listen(1949, () => {
	console.log('listening on *:1949');
});