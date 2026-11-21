import { footer } from "./Footer";
import { lower } from "./helpers";
import { endOfDay } from "./date-utils";
import { startOfDay } from "./date_utils";
import { orderTotal } from "./orderService";
import { userCard } from "./UserCard";
import { ButtonGroup } from "./ui/ButtonGroup";

export const page = [footer, lower("X"), endOfDay, startOfDay, orderTotal(1), userCard("a"), ButtonGroup];
