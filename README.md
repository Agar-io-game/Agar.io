## **Info:**

a re-creation of: http://senpai-agar.online/nano/ EA-Caffe server, an agar.io style game.

100% of the code was written by claude Opus 5.5


## **Requirements:**

node.js 18 or more


## **Installation:**

1: download repo > unzip

2: open CLI inside C:\Users\ (You) \game\server

3: type npm install and click enter

4: type npm start and click enter

5: open http://localhost:2525 in browser

6: play

* don't close the CLI while playing, otherwise you will terminate the session

* npm install command only happens one time, the first time. next time you want to play just type npm start


## **What's in:**
1: game: the game, and the bot

2: readme.md: this

3: game_example.gz: this file is one of the games the bot was trained on, a game played by me, solo, using unit 2 to simulate a team-mate. played on the same sandbox rules the bot was trained on, 35K~ mass, no walls, no mass decay.

4: viewer.html: this file translates the example game from text to visual. it opens a page in browser, click & drag the .gz file into the page to load it. you can see how I performed and what the bot learned from.


## **Bot:**
proof of concept split-run bot. trained on 4-5 games. for now it plays solo only and is in it's early stages. my resolution: perfect flawless split run with duo mode and a coach mode that points out mistakes then suggests better/optimal splits at any given situation. in game chat type /bot v1, /bot v2, or /bot dev, for different versions of the bot. use /bot stop to remove the bot. the bot starts from a specific situation that I gave it during training. that is because training it from zero caused it to get entangled and waste so much time.



https://github.com/user-attachments/assets/bc2b7967-7aac-4c80-a99d-1bec14f511af



## **Miscellaneous:**
since this sandbox has no bots, viruses, or food, you can generate mass by typing /mass 25000 for example in the game chat.
some native settings are removed like the replay bar and bug split for example. 2 new settings: infinite map, mass decay, ON/OFF

## **Gallery:**

<table>
  <tr>
    <td><video src="https://github.com/user-attachments/assets/640774d0-0f22-49e1-a63d-729055fc682b" controls></video></td>
    <td><video src="https://github.com/user-attachments/assets/022a2c28-24c4-470d-80da-0807391c4464" controls></video></td>
  </tr>
</table>
