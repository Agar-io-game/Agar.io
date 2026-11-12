## **Info:**

A re-creation of: http://senpai-agar.online/nano/ EA-Caffe server, an agar.io style game.

100% of the code was written by Claude Opus 5.5


## **Requirements:**

node.js 18 or more


## **Installation:**

1: Download repo > unzip

2: Open CMD inside C:\Users\(You)\game\server

3: Type npm install and click enter

4: Type npm start and click enter

5: open http://localhost:2525 in browser

6: play

* Don't close the CMD while playing, otherwise you will terminate the session

* npm install command only happens one time, first time; next time you want to play just type npm start


## **what's in:**
1: game: the game
2: readme.md: this
3: game_example.gz: split run game, performed by me solo
4: viewer.html: the viewer that translates the example game into visual



## **Bot:**
Proof of concept split-run bot. Trained on 4-5 games. For now it plays solo and is in it's early stages, my resolution: perfect flawless split run with duo mode and a coach mode that points out mistakes then suggests better/optimal splits at any given situation. in the in-game chat type /bot v1, /bot v2, or /bot dev, for different versions of the bot. use /bot stop, to stop the bot. The bot starts from a specific situation that I gave it during training. That is because training it from zero caused it to get entangled and wasted so much time.
The game_example.gz file, is a game played by human, me, solo, using unit 2 to simulate a team-mate. It uses the same sandbox parameters the bot was trained on, 35K~ mass, no walls, no decay. The viewer.html file opens a page in browser that shows the game visually, so you can see how I performed and how the bot was taught.


https://github.com/user-attachments/assets/bc2b7967-7aac-4c80-a99d-1bec14f511af



## **Miscellaneous:**
Since this sandbox has no bots, viruses, or food, you can generate mass by typing /mass 25000 for example in the game chat.
some native settings are removed like the replay bar and bug split for example. 2 new settings: infinite map, mass decay, ON/OFF

## **Gallery:**

<table>
  <tr>
    <td><video src="https://github.com/user-attachments/assets/640774d0-0f22-49e1-a63d-729055fc682b" controls></video></td>
    <td><video src="https://github.com/user-attachments/assets/022a2c28-24c4-470d-80da-0807391c4464" controls></video></td>
  </tr>
</table>
