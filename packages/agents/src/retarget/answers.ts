import { splitFollowUps } from "../interview/follow-ups";
import {
  answersToOwnServer,
  answersToSharedServer,
  askServerQuestions,
  type OwnServerContext,
  SERVER_FIELDS,
  type ServerQuestion,
} from "../interview/own-server";
import type { InterviewAnswers } from "../interview/questions";
import type { RetargetOptions } from "./types";

/**
 * The new side's answers for `opscrew retarget --to own`, as `opscrew interview` takes them
 * (FR-3021): from `given` (an answers file's `server.*`), else asked in a terminal (`ask`, in the
 * interview's rounds: which kind of server first). `server.shares*` name the repository folder of
 * another app whose server OpsCrew created (`sharedServer`), read before the own server's login
 * answers (`ownServer`), which refuse them. `context.root` is where a relative folder is read
 * from. Nothing is recorded here: the move's start does that.
 * @throws OpsCrewError `INVALID_INPUT` naming each missing or invalid answer.
 */
export async function moveServerAnswers(input: {
  given?: InterviewAnswers;
  ask?: (questions: ServerQuestion[]) => Promise<InterviewAnswers>;
  context: OwnServerContext;
}): Promise<Pick<RetargetOptions, "ownServer" | "sharedServer">> {
  const { context } = input;
  const answers =
    input.given ?? (input.ask === undefined ? {} : await askServerQuestions(input.ask, context));
  const split = splitFollowUps(answers, "server", SERVER_FIELDS);
  const shares = await answersToSharedServer(split, context);
  return shares !== undefined
    ? { sharedServer: shares }
    : { ownServer: answersToOwnServer(split, context) };
}
