# Scene 2: first task

**Shows:** ask for a change from Telegram, approve one step with a tap, see the result.
**Right pane:** the Mealplan site, then the terminal, then the site again.
**Starts from:** Mealplan at its starting point (tag `demo-start`), an empty chat.

## Beats

1. **The site as it is.** The Mealplan home page on the right.
2. **The task.** Alex types: "Add a page that shows this week's meals, one recipe per
   day, and link it from the home page. Commit it and push."
3. **Claude works.** Progress streams into the chat. The wait is cut.
4. **One approval.** Claude asks before `git push`. Alex taps "Yes".
5. **Done.** The answer and the status line arrive.
6. **Proof in the terminal.** `git log` shows the new commit.
7. **Proof in the browser.** Alex clicks the new week link on the home page and the
   week page opens. End.

## Checks

- The repo has a new commit, and the remote has it too.
- The home page links to the week page.
