#include <empathy.h>

#include <cassert>
#include <cstdint>
#include <iostream>
#include <limits>
#include <vector>

enum AtomType : uint32_t
{
	ATOM_TYPE_LINE = 0,
	ATOM_TYPE_CHARACTER,
	ATOM_TYPE_CHOICE,
};

enum YieldType : uint32_t
{
	YIELD_TYPE_LINE = 0,
	YIELD_TYPE_CHOICE,
	YIELD_TYPE_SAY,
};

enum LineAtom : uint32_t
{
	LINE_RAIN_ERASED_ROAD = 1000,
	LINE_SIGNAL_TOWER_LIT,
	LINE_SOMEONE_WAITING,
	LINE_MARA_CLIMBS_TOWER,
	LINE_LAMP_IS_WARM,
	LINE_ILYA_FOLLOWS_FOOTPRINTS,
	LINE_LED_IN_A_CIRCLE,
	LINE_TRAILS_END_AT_WAITING_ROOM,
	LINE_KEEPER_TOOK_YOUR_TIME,
	LINE_MARA_SCENIC_ROUTE,
	LINE_STATION_CLOCK_MOVES,
};

enum ChoiceAtom : uint32_t
{
	CHOICE_CLIMB_TO_SIGNAL_ROOM = 73,
	CHOICE_FOLLOW_FOOTPRINTS = 91,
};

struct AtomText
{
	uint32_t value;
	const char *text;
};

static const AtomText lines[] =
{
	{LINE_RAIN_ERASED_ROAD, "Rain erased the road behind the last train."},
	{LINE_SIGNAL_TOWER_LIT, "The signal tower is still lit."},
	{LINE_SOMEONE_WAITING, "Then either someone is waiting, or someone forgot to leave."},
	{LINE_MARA_CLIMBS_TOWER, "Mara climbs the iron stairs while the tower sways in the wind."},
	{LINE_LAMP_IS_WARM, "The lamp is warm. Whoever lit it cannot be far."},
	{LINE_ILYA_FOLLOWS_FOOTPRINTS, "Ilya follows the fresh footprints along the flooded platform."},
	{LINE_LED_IN_A_CIRCLE, "They turn back toward the station. We are being led in a circle."},
	{LINE_TRAILS_END_AT_WAITING_ROOM, "Both trails end at the locked waiting room."},
	{LINE_KEEPER_TOOK_YOUR_TIME, "You took your time."},
	{LINE_MARA_SCENIC_ROUTE, "We took the scenic route."},
	{LINE_STATION_CLOCK_MOVES, "Inside, the station clock begins to move again."},
};

static const char *characters[] =
{
	"Mara",
	"Ilya",
	"Keeper",
};

static const AtomText choices[] =
{
	{CHOICE_CLIMB_TO_SIGNAL_ROOM, "Climb to the signal room"},
	{CHOICE_FOLLOW_FOOTPRINTS, "Follow the footprints"},
};

template <size_t N>
static const char *findAtomText(const AtomText (&values)[N], uint32_t atom)
{
	for (const AtomText &value : values)
		if (value.value == atom)
			return value.text;
	return nullptr;
}

static void handleLine(Empathy_Instance instance, Empathy_Machine machine)
{
	uint32_t stack_size = 0;
	Empathy_Result result = empathyGetYieldStackSize(instance, machine, &stack_size);
	assert(result == EMPATHY_SUCCESS);
	assert(stack_size == 1);

	Empathy_Value line = {};
	result = empathyYieldStackPeek(instance, machine, 0, &line);
	assert(result == EMPATHY_SUCCESS);
	assert(line.type.base_type == EMPATHY_VALUE_BASE_TYPE_ATOM);
	assert(line.type.atom_type == ATOM_TYPE_LINE);
	assert(line.data.atom.type == ATOM_TYPE_LINE);
	const char *text = findAtomText(lines, line.data.atom.value);
	assert(text);
	std::cout << "\n" << text << "\n";

	result = empathyYieldStackPop(instance, machine, &line);
	assert(result == EMPATHY_SUCCESS);
}

static void handleChoice(Empathy_Instance instance, Empathy_Machine machine)
{
	uint32_t stack_size = 0;
	Empathy_Result result = empathyGetYieldStackSize(instance, machine, &stack_size);
	assert(result == EMPATHY_SUCCESS);
	assert(stack_size > 0);
	std::vector<Empathy_Atom> visible_choices(stack_size);

	std::cout << "\n";
	for (uint32_t i = 0; i < stack_size; ++i)
	{
		Empathy_Value choice = {};
		result = empathyYieldStackPeek(instance, machine, stack_size - 1 - i, &choice);
		assert(result == EMPATHY_SUCCESS);
		assert(choice.type.base_type == EMPATHY_VALUE_BASE_TYPE_ATOM);
		assert(choice.type.atom_type == ATOM_TYPE_CHOICE);
		assert(choice.data.atom.type == ATOM_TYPE_CHOICE);
		const char *text = findAtomText(choices, choice.data.atom.value);
		assert(text);
		visible_choices[i] = choice.data.atom;
		std::cout << "  " << i + 1 << ". " << text << "\n";
	}

	for (uint32_t i = 0; i < stack_size; ++i)
	{
		Empathy_Value value = {};
		result = empathyYieldStackPop(instance, machine, &value);
		assert(result == EMPATHY_SUCCESS);
	}

	Empathy_Value response = {};
	response.type = {EMPATHY_VALUE_BASE_TYPE_ATOM, ATOM_TYPE_CHOICE};
	response.data.atom = visible_choices[0];

	for (;;)
	{
		std::cout << "> ";

		uint32_t selection = 0;
		if (std::cin >> selection)
		{
			if (selection > 0 && selection <= stack_size)
			{
				response.data.atom = visible_choices[selection - 1];
				break;
			}
		}
		else if (std::cin.eof())
		{
			std::cout << "No input available; choosing option 1.\n";
			break;
		}

		std::cin.clear();
		std::cin.ignore(std::numeric_limits<std::streamsize>::max(), '\n');
		std::cout << "Choose a number from 1 to " << stack_size << ".\n";
	}

	result = empathyYieldStackPush(instance, machine, response);
	assert(result == EMPATHY_SUCCESS);
}

static void handleSay(Empathy_Instance instance, Empathy_Machine machine)
{
	uint32_t stack_size = 0;
	Empathy_Result result = empathyGetYieldStackSize(instance, machine, &stack_size);
	assert(result == EMPATHY_SUCCESS);
	assert(stack_size == 2);

	Empathy_Value line = {};
	result = empathyYieldStackPeek(instance, machine, 1, &line);
	assert(result == EMPATHY_SUCCESS);
	assert(line.type.base_type == EMPATHY_VALUE_BASE_TYPE_ATOM);
	assert(line.type.atom_type == ATOM_TYPE_LINE);
	assert(line.data.atom.type == ATOM_TYPE_LINE);
	const char *line_text = findAtomText(lines, line.data.atom.value);
	assert(line_text);

	Empathy_Value character = {};
	result = empathyYieldStackPeek(instance, machine, 0, &character);
	assert(result == EMPATHY_SUCCESS);
	assert(character.type.base_type == EMPATHY_VALUE_BASE_TYPE_ATOM);
	assert(character.type.atom_type == ATOM_TYPE_CHARACTER);
	assert(character.data.atom.type == ATOM_TYPE_CHARACTER);
	assert(character.data.atom.value < sizeof(characters) / sizeof(characters[0]));

	std::cout << characters[character.data.atom.value] << ": " << line_text << "\n";

	result = empathyYieldStackPop(instance, machine, &character);
	assert(result == EMPATHY_SUCCESS);
	result = empathyYieldStackPop(instance, machine, &line);
	assert(result == EMPATHY_SUCCESS);
}

static void runStory(Empathy_Instance instance)
{
	Empathy_AtomTypeDesc atom_types[] =
	{
		{ATOM_TYPE_LINE, LINE_RAIN_ERASED_ROAD, LINE_STATION_CLOCK_MOVES},
		{ATOM_TYPE_CHARACTER, 0, static_cast<uint32_t>(sizeof(characters) / sizeof(characters[0])) - 1},
		{ATOM_TYPE_CHOICE, CHOICE_CLIMB_TO_SIGNAL_ROOM, CHOICE_FOLLOW_FOOTPRINTS},
	};

	// line   -> line atom
	// choice -> visible choice atoms only; resumes with the selected CHOICE atom
	// say    -> line atom, character atom
	Empathy_ValueType choice_resume_types[] =
	{
		{EMPATHY_VALUE_BASE_TYPE_ATOM, ATOM_TYPE_CHOICE},
	};

	Empathy_YieldDesc yields[] =
	{
		{0, nullptr},
		{1, choice_resume_types},
		{0, nullptr},
	};

	Empathy_ProgramLayoutDesc layout_desc =
	{
		3, atom_types,
		0, nullptr,
		3, yields,
	};

	Empathy_ProgramLayout layout = EMPATHY_NULL_HANDLE;
	Empathy_Result result = empathyCreateProgramLayout(instance, &layout_desc, &layout);
	assert(result == EMPATHY_SUCCESS);

	/*
	 * 000: line LINE_RAIN_ERASED_ROAD
	 * 014: say  LINE_SIGNAL_TOWER_LIT, character[0]
	 * 037: say  LINE_SOMEONE_WAITING, character[1]
	 * 060: choice [CHOICE_CLIMB_TO_SIGNAL_ROOM, CHOICE_FOLLOW_FOOTPRINTS]
	 * 083: take selected CHOICE atom and dispatch; invalid atoms end at 145
	 * 146: first branch
	 * 192: second branch
	 * 229: shared ending
	 * 303: end
	 */
	const uint8_t payload[] =
	{
		// line line[0]
		EMPATHY_BYTECODE_OP_YIELD_PUSH_ATOM, 0x00, 0x00, 0x00, 0x00, 0xE8, 0x03, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_YIELD, 0x00, 0x00, 0x00, 0x00,

		// say line[1], character[0]
		EMPATHY_BYTECODE_OP_YIELD_PUSH_ATOM, 0x00, 0x00, 0x00, 0x00, 0xE9, 0x03, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_YIELD_PUSH_ATOM, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_YIELD, 0x02, 0x00, 0x00, 0x00,

		// say line[2], character[1]
		EMPATHY_BYTECODE_OP_YIELD_PUSH_ATOM, 0x00, 0x00, 0x00, 0x00, 0xEA, 0x03, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_YIELD_PUSH_ATOM, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_YIELD, 0x02, 0x00, 0x00, 0x00,

		// visible CHOICE atoms only
		EMPATHY_BYTECODE_OP_YIELD_PUSH_ATOM, 0x02, 0x00, 0x00, 0x00, 0x49, 0x00, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_YIELD_PUSH_ATOM, 0x02, 0x00, 0x00, 0x00, 0x5B, 0x00, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_YIELD, 0x01, 0x00, 0x00, 0x00,

		// Dispatch the selected stable CHOICE atom. Unknown atoms end safely.
		EMPATHY_BYTECODE_OP_YIELD_TAKE,
		EMPATHY_BYTECODE_OP_DUP,
		EMPATHY_BYTECODE_OP_PUSH_ATOM, 0x02, 0x00, 0x00, 0x00, 0x49, 0x00, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_EQUAL,
		EMPATHY_BYTECODE_OP_JUMP_FALSE, 0x72, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_DROP,
		EMPATHY_BYTECODE_OP_JUMP, 0x92, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_DUP,
		EMPATHY_BYTECODE_OP_PUSH_ATOM, 0x02, 0x00, 0x00, 0x00, 0x5B, 0x00, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_EQUAL,
		EMPATHY_BYTECODE_OP_JUMP_FALSE, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_DROP,
		EMPATHY_BYTECODE_OP_JUMP, 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_DROP,
		EMPATHY_BYTECODE_OP_END,

		// First branch: signal room
		EMPATHY_BYTECODE_OP_YIELD_PUSH_ATOM, 0x00, 0x00, 0x00, 0x00, 0xEB, 0x03, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_YIELD, 0x00, 0x00, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_YIELD_PUSH_ATOM, 0x00, 0x00, 0x00, 0x00, 0xEC, 0x03, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_YIELD_PUSH_ATOM, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_YIELD, 0x02, 0x00, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_JUMP, 0xE5, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,

		// Second branch: footprints
		EMPATHY_BYTECODE_OP_YIELD_PUSH_ATOM, 0x00, 0x00, 0x00, 0x00, 0xED, 0x03, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_YIELD, 0x00, 0x00, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_YIELD_PUSH_ATOM, 0x00, 0x00, 0x00, 0x00, 0xEE, 0x03, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_YIELD_PUSH_ATOM, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_YIELD, 0x02, 0x00, 0x00, 0x00,

		// Shared ending
		EMPATHY_BYTECODE_OP_YIELD_PUSH_ATOM, 0x00, 0x00, 0x00, 0x00, 0xEF, 0x03, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_YIELD, 0x00, 0x00, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_YIELD_PUSH_ATOM, 0x00, 0x00, 0x00, 0x00, 0xF0, 0x03, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_YIELD_PUSH_ATOM, 0x01, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_YIELD, 0x02, 0x00, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_YIELD_PUSH_ATOM, 0x00, 0x00, 0x00, 0x00, 0xF1, 0x03, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_YIELD_PUSH_ATOM, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_YIELD, 0x02, 0x00, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_YIELD_PUSH_ATOM, 0x00, 0x00, 0x00, 0x00, 0xF2, 0x03, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_YIELD, 0x00, 0x00, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_END,
	};

	Empathy_EntryPointDesc entries[] =
	{
		{0, EMPATHY_PROGRAM_OFFSET_NONE},
	};

	Empathy_ProgramDesc program_desc =
	{
		layout,
		1, entries,
		EMPATHY_BYTECODE_VERSION, sizeof(payload), payload,
	};

	Empathy_Program program = EMPATHY_NULL_HANDLE;
	result = empathyCreateProgram(instance, &program_desc, &program);
	assert(result == EMPATHY_SUCCESS);

	Empathy_MachineDesc machine_desc =
	{
		16,
		16,
		8,
		0,
		1024,
	};

	Empathy_Machine machine = EMPATHY_NULL_HANDLE;
	result = empathyCreateMachine(instance, &machine_desc, &machine);
	assert(result == EMPATHY_SUCCESS);

	result = empathyBindProgram(instance, machine, program);
	assert(result == EMPATHY_SUCCESS);

	result = empathyBindProgramEntryPoint(instance, machine, 0);
	assert(result == EMPATHY_SUCCESS);

	for (;;)
	{
		result = empathyRun(instance, machine);
		if (result == EMPATHY_EXECUTION_END)
			break;

		assert(result == EMPATHY_EXECUTION_YIELD);

		uint32_t yield_index = 0;
		result = empathyGetYieldIndex(instance, machine, &yield_index);
		assert(result == EMPATHY_SUCCESS);

		switch (yield_index)
		{
			case YIELD_TYPE_LINE: handleLine(instance, machine); break;
			case YIELD_TYPE_CHOICE: handleChoice(instance, machine); break;
			case YIELD_TYPE_SAY: handleSay(instance, machine); break;
			default: assert(false); break;
		}
	}

	result = empathyDestroyMachine(instance, machine);
	assert(result == EMPATHY_SUCCESS);

	result = empathyDestroyProgram(instance, program);
	assert(result == EMPATHY_SUCCESS);

	result = empathyDestroyProgramLayout(instance, layout);
	assert(result == EMPATHY_SUCCESS);
}

int main()
{
	Empathy_Instance instance = EMPATHY_NULL_HANDLE;
	Empathy_InstanceDesc instance_desc = {};

	Empathy_Result result = empathyCreateInstance(&instance_desc, &instance);
	assert(result == EMPATHY_SUCCESS);

	runStory(instance);

	result = empathyDestroyInstance(instance);
	assert(result == EMPATHY_SUCCESS);

	return 0;
}
